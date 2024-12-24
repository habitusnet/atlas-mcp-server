import { Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { TaskStorage } from '../../types/storage.js';
import { Task, TaskStatus, CreateTaskInput, UpdateTaskInput } from '../../types/task.js';
import { Logger } from '../../logging/index.js';
import { ErrorCodes, createError } from '../../errors/index.js';
import { initializeSqliteStorage } from './init.js';

// Constants
export const DEFAULT_PAGE_SIZE = 4096;
export const DEFAULT_CACHE_SIZE = 2000;
export const DEFAULT_BUSY_TIMEOUT = 5000;

// Configuration types
export interface SqliteConfig {
    baseDir: string;
    name: string;
    sqlite?: {
        journalMode?: 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'WAL' | 'OFF';
        synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
        tempStore?: 'DEFAULT' | 'FILE' | 'MEMORY';
        lockingMode?: 'NORMAL' | 'EXCLUSIVE';
        autoVacuum?: 'NONE' | 'FULL' | 'INCREMENTAL';
    };
    performance?: {
        pageSize?: number;
        cacheSize?: number;
        mmapSize?: number;
    };
    connection?: {
        busyTimeout?: number;
        maxRetries?: number;
        retryDelay?: number;
    };
}

export class SqliteStorage implements TaskStorage {
    private db: Database | null = null;
    private readonly logger: Logger;
    private readonly dbPath: string;

    constructor(private readonly config: SqliteConfig) {
        this.logger = Logger.getInstance().child({ component: 'SqliteStorage' });
        this.dbPath = `${config.baseDir}/${config.name}.db`;
    }

    async initialize(): Promise<void> {
        try {
            // Initialize SQLite with WAL mode
            this.db = await open({
                filename: this.dbPath,
                driver: sqlite3.Database,
                mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
            });

            // Configure database
            await this.db.exec(`
                PRAGMA journal_mode=${this.config.sqlite?.journalMode || 'WAL'};
                PRAGMA synchronous=${this.config.sqlite?.synchronous || 'NORMAL'};
                PRAGMA temp_store=${this.config.sqlite?.tempStore || 'MEMORY'};
                PRAGMA locking_mode=${this.config.sqlite?.lockingMode || 'NORMAL'};
                PRAGMA auto_vacuum=${this.config.sqlite?.autoVacuum || 'NONE'};
                PRAGMA page_size=${this.config.performance?.pageSize || DEFAULT_PAGE_SIZE};
                PRAGMA cache_size=${this.config.performance?.cacheSize || DEFAULT_CACHE_SIZE};
                PRAGMA mmap_size=${this.config.performance?.mmapSize || 30000000000};
                PRAGMA busy_timeout=${this.config.connection?.busyTimeout || DEFAULT_BUSY_TIMEOUT};
            `);

            // Initialize storage
            await initializeSqliteStorage(this.dbPath);

            this.logger.info('SQLite storage initialized', {
                path: this.dbPath,
                config: this.config
            });
        } catch (error) {
            this.logger.error('Failed to initialize SQLite storage', {
                error: error instanceof Error ? error.message : String(error),
                path: this.dbPath
            });
            throw createError(
                ErrorCodes.STORAGE_INIT,
                'Failed to initialize SQLite storage',
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    private isClosed = false;

    async close(): Promise<void> {
        if (!this.db || this.isClosed) {
            return;
        }

        try {
            this.isClosed = true;
            await this.db.close();
            this.db = null;
            this.logger.info('SQLite connection closed');
        } catch (error) {
            if (error instanceof Error && error.message.includes('Database handle is closed')) {
                // Ignore already closed errors
                return;
            }
            this.logger.error('Error closing SQLite connection', {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    // Transaction methods
    async beginTransaction(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.run('BEGIN IMMEDIATE');
    }

    async commitTransaction(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.run('COMMIT');
    }

    async rollbackTransaction(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.run('ROLLBACK');
    }

    // Task operations
    async createTask(input: CreateTaskInput): Promise<Task> {
        if (!this.db) throw new Error('Database not initialized');
        
        if (!input.path || !input.name || !input.type) {
            throw createError(
                ErrorCodes.VALIDATION_ERROR,
                'Missing required fields',
                'createTask',
                'path, name, and type are required'
            );
        }

        const task: Task = {
            path: input.path,
            name: input.name,
            type: input.type,
            status: TaskStatus.PENDING,
            description: input.description,
            parentPath: input.parentPath,
            notes: input.notes || [],
            reasoning: input.reasoning,
            dependencies: input.dependencies || [],
            subtasks: [],
            metadata: {
                ...input.metadata,
                created: Date.now(),
                updated: Date.now(),
                projectPath: input.path.split('/')[0],
                version: 1
            }
        };

        await this.saveTask(task);
        return task;
    }

    async updateTask(path: string, updates: UpdateTaskInput): Promise<Task> {
        if (!this.db) throw new Error('Database not initialized');
        
        const existingTask = await this.getTask(path);
        if (!existingTask) {
            throw createError(
                ErrorCodes.TASK_NOT_FOUND,
                'Task not found',
                'updateTask',
                path
            );
        }

        const updatedTask: Task = {
            ...existingTask,
            ...updates,
            metadata: {
                ...existingTask.metadata,
                ...updates.metadata,
                updated: Date.now(),
                version: existingTask.metadata.version + 1
            }
        };

        await this.saveTask(updatedTask);
        return updatedTask;
    }

    async getTask(path: string): Promise<Task | null> {
        if (!this.db) throw new Error('Database not initialized');
        
        const row = await this.db.get<Record<string, unknown>>(
            'SELECT * FROM tasks WHERE path = ?',
            path
        );

        if (!row) return null;
        return this.rowToTask(row);
    }

    async getTasks(paths: string[]): Promise<Task[]> {
        if (!this.db) throw new Error('Database not initialized');
        
        if (paths.length === 0) return [];

        const placeholders = paths.map(() => '?').join(',');
        const rows = await this.db.all<Record<string, unknown>[]>(
            `SELECT * FROM tasks WHERE path IN (${placeholders})`,
            ...paths
        );

        return rows.map(row => this.rowToTask(row));
    }

    async getTasksByPattern(pattern: string): Promise<Task[]> {
        if (!this.db) throw new Error('Database not initialized');
        
        const sqlPattern = pattern.replace(/\*/g, '%').replace(/\?/g, '_');
        const rows = await this.db.all<Record<string, unknown>[]>(
            'SELECT * FROM tasks WHERE path LIKE ?',
            sqlPattern
        );

        return rows.map(row => this.rowToTask(row));
    }

    async getTasksByStatus(status: TaskStatus): Promise<Task[]> {
        if (!this.db) throw new Error('Database not initialized');
        
        const rows = await this.db.all<Record<string, unknown>[]>(
            'SELECT * FROM tasks WHERE status = ?',
            status
        );

        return rows.map(row => this.rowToTask(row));
    }

    async getSubtasks(parentPath: string): Promise<Task[]> {
        if (!this.db) throw new Error('Database not initialized');
        
        const rows = await this.db.all<Record<string, unknown>[]>(
            'SELECT * FROM tasks WHERE parent_path = ?',
            parentPath
        );

        return rows.map(row => this.rowToTask(row));
    }

    async deleteTask(path: string): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.deleteTasks([path]);
    }

    async deleteTasks(paths: string[]): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        if (paths.length === 0) return;

        const placeholders = paths.map(() => '?').join(',');
        await this.db.run(
            `DELETE FROM tasks WHERE path IN (${placeholders})`,
            ...paths
        );
    }

    async hasChildren(path: string): Promise<boolean> {
        if (!this.db) throw new Error('Database not initialized');
        const result = await this.db.get<{ count: number }>(
            'SELECT COUNT(*) as count FROM tasks WHERE parent_path = ?',
            path
        );
        return (result?.count || 0) > 0;
    }

    async getDependentTasks(path: string): Promise<Task[]> {
        if (!this.db) throw new Error('Database not initialized');
        const rows = await this.db.all<Record<string, unknown>[]>(
            `SELECT * FROM tasks WHERE json_array_length(dependencies) > 0 
             AND json_extract(dependencies, '$') LIKE '%${path}%'`
        );
        return rows.map(row => this.rowToTask(row));
    }

    async saveTask(task: Task): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.saveTasks([task]);
    }

    async saveTasks(tasks: Task[]): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        for (const task of tasks) {
            await this.db.run(
                `INSERT OR REPLACE INTO tasks (
                    path, name, description, type, status,
                    parent_path, notes, reasoning, dependencies,
                    subtasks, metadata, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                task.path,
                task.name,
                task.description,
                task.type,
                task.status,
                task.parentPath,
                task.notes ? JSON.stringify(task.notes) : null,
                task.reasoning,
                JSON.stringify(task.dependencies),
                JSON.stringify(task.subtasks),
                JSON.stringify(task.metadata),
                task.metadata.created,
                task.metadata.updated
            );
        }
    }

    async clearAllTasks(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.run('DELETE FROM tasks');
    }

    private rowToTask(row: Record<string, unknown>): Task {
        return {
            path: String(row.path || ''),
            name: String(row.name || ''),
            description: row.description ? String(row.description) : undefined,
            type: String(row.type || '') as Task['type'],
            status: String(row.status || '') as TaskStatus,
            parentPath: row.parent_path ? String(row.parent_path) : undefined,
            notes: this.parseJSON<string[]>(String(row.notes || '[]'), []),
            reasoning: row.reasoning ? String(row.reasoning) : undefined,
            dependencies: this.parseJSON<string[]>(String(row.dependencies || '[]'), []),
            subtasks: this.parseJSON<string[]>(String(row.subtasks || '[]'), []),
            metadata: this.parseJSON(String(row.metadata || '{}'), {
                created: Number(row.created_at),
                updated: Number(row.updated_at),
                projectPath: String(row.path || '').split('/')[0],
                version: 1
            })
        };
    }

    private parseJSON<T>(value: string | null | undefined, defaultValue: T): T {
        if (!value) return defaultValue;
        try {
            return JSON.parse(value) as T;
        } catch {
            return defaultValue;
        }
    }

    async vacuum(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.run('VACUUM');
    }

    async analyze(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.run('ANALYZE');
    }

    async checkpoint(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    }

    async repairRelationships(dryRun: boolean = false): Promise<{ fixed: number, issues: string[] }> {
        if (!this.db) throw new Error('Database not initialized');
        
        const issues: string[] = [];
        let fixed = 0;

        // Find tasks with invalid parent paths
        const orphanedTasks = await this.db.all<Record<string, unknown>[]>(
            `SELECT t1.path, t1.parent_path 
             FROM tasks t1 
             LEFT JOIN tasks t2 ON t1.parent_path = t2.path 
             WHERE t1.parent_path IS NOT NULL 
             AND t2.path IS NULL`
        );

        for (const task of orphanedTasks) {
            issues.push(`Task ${task.path} has invalid parent_path: ${task.parent_path}`);
            if (!dryRun) {
                await this.db.run(
                    'UPDATE tasks SET parent_path = NULL WHERE path = ?',
                    task.path
                );
                fixed++;
            }
        }

        return { fixed, issues };
    }

    async clearCache(): Promise<void> {
        // SQLite implementation doesn't use cache
        return;
    }

    async getMetrics(): Promise<{
        tasks: {
            total: number;
            byStatus: Record<string, number>;
            noteCount: number;
            dependencyCount: number;
        };
        storage: {
            totalSize: number;
            pageSize: number;
            pageCount: number;
            walSize: number;
            cache: {
                hitRate: number;
                memoryUsage: number;
                entryCount: number;
            };
        };
    }> {
        if (!this.db) throw new Error('Database not initialized');

        const [taskStats, statusStats, storageStats] = await Promise.all([
            this.db.get<{
                total: number;
                noteCount: number;
                dependencyCount: number;
            }>(`
                SELECT 
                    COUNT(*) as total,
                    COUNT(CASE WHEN notes IS NOT NULL THEN 1 END) as noteCount,
                    SUM(CASE 
                        WHEN dependencies IS NOT NULL 
                        AND json_valid(dependencies) 
                        AND json_array_length(dependencies) > 0 
                        THEN json_array_length(dependencies) 
                        ELSE 0 
                    END) as dependencyCount
                FROM tasks
            `),
            this.db.all<{ status: string; count: number }[]>(`
                SELECT status, COUNT(*) as count
                FROM tasks
                GROUP BY status
            `),
            this.db.get<{
                page_count: number;
                page_size: number;
            }>(`
                SELECT 
                    page_count,
                    page_size
                FROM pragma_page_count, pragma_page_size
                LIMIT 1
            `)
        ]);

        // Convert status stats array to object
        const byStatus = statusStats.reduce((acc: Record<string, number>, curr) => {
            acc[curr.status] = curr.count;
            return acc;
        }, {});

        const totalSize = (storageStats?.page_count || 0) * (storageStats?.page_size || 0);
        const memUsage = process.memoryUsage();

        return {
            tasks: {
                total: Number(taskStats?.total || 0),
                byStatus,
                noteCount: Number(taskStats?.noteCount || 0),
                dependencyCount: Number(taskStats?.dependencyCount || 0)
            },
            storage: {
                totalSize,
                pageSize: Number(storageStats?.page_size || 0),
                pageCount: Number(storageStats?.page_count || 0),
                walSize: 0, // WAL size is dynamic
                cache: {
                    hitRate: 0, // SQLite implementation doesn't use cache
                    memoryUsage: memUsage.heapUsed,
                    entryCount: 0
                }
            }
        };
    }
}
