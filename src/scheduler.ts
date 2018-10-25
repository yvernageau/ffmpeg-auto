import * as Queue from 'better-queue'
import {LoggerFactory} from './logger'
import {Profile} from './profile'

const logger = LoggerFactory.get('scheduler')

export class Scheduler {

    private readonly profile: Profile

    private readonly queue: Queue

    private readonly tasks: Map<number, string> = new Map<number, string>()
    private taskCount: number = 0

    private currentTask: number = 0

    constructor(profile: Profile, onProcess: Queue.ProcessFunction<any, never>) {
        this.profile = profile

        this.queue = new Queue(
            onProcess,
            {
                id: (file, callback) => callback(null, this.createId(file)),
                afterProcessDelay: 10 * 1000, // Waiting 10 seconds
                cancelIfRunning: false
            })
            .on('task_queued', (id, arg) => {
                logger.info('#%s - Scheduled: %s', id, arg)
            })
            .on('task_started', id => {
                logger.info('#%s - Started', id)
                this.currentTask = id
            })
            .on('task_finish', id => {
                logger.info('#%s - Done', id)
                this.tasks.delete(id)
            })
            .on('task_failed', (id, message) => {
                logger.error('#%s - Failed: %s', id, message)
                this.tasks.delete(id)
            })
            .on('error', (id, error) => {
                logger.error('#%s - %s', id, error)
                this.tasks.delete(id)
            })

        process.on('exit', () => this.queue.destroy(() => {
        }))
    }

    schedule(file: string) {
        this.queue.push(file)
    }

    cancel(file: string) {
        const id = this.findId(file)
        if (id > this.currentTask) {
            this.queue.cancel(id, () => {
                logger.info('#%s - Cancelled', id)
                this.tasks.delete(id)
            })
        }
    }

    private createId(file: string) {
        const id = ++this.taskCount
        this.tasks.set(id, file)
        return id
    }

    private findId(file: string) {
        for (let [k, v] of this.tasks.entries()) {
            if (v === file) {
                return k
            }
        }
        return -1
    }
}