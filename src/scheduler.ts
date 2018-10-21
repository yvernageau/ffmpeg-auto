import * as Queue from 'better-queue'
import {ProcessFunctionCb} from 'better-queue'
import * as fs from 'fs-extra'
import {LoggerFactory} from './logger'
import {InputMedia} from './media'
import {Profile} from './profile'
import {Worker} from './worker'

const logger = LoggerFactory.createDefault('scheduler')

export class Scheduler {

    private readonly profile: Profile

    private readonly queue: Queue
    private queueCount: number = 0

    constructor(profile: Profile) {
        this.profile = profile

        this.queue = new Queue(
            {
                id: ((input, callback) => callback(null, this.generateId(input))),
                process: (input, callback) => this.process(input, callback)
            })
            .on('task_queued', (id, input) => this.onQueued(id, input))
            .on('task_started', id => this.onStart(id))
            .on('task_finish', id => this.onEnd(id))
            .on('task_failed', (id, message) => this.onFailure(id, message))
            .on('error', (id, error) => this.onError(id, error))

        process.on('exit', () => this.queue.destroy(() => {
        }))
    }

    schedule(input: InputMedia) {
        this.queue.push(input)
    }

    private generateId(input: InputMedia) {
        return `#${++this.queueCount}`
    }

    private process(input: InputMedia, callback: ProcessFunctionCb<never>) {
        fs.stat(input.resolvePath())
            .then((() => new Worker(this.profile, input).execute()
                    .catch(reason => callback(reason))
                    .then(() => callback(null))
            ))
            .catch(reason => callback(reason))
    }

    private onQueued(id: string, input: InputMedia) {
        logger.info('%s - Scheduled: %s', id, input.resolvePath())
    }

    private onStart(id: string) {
        logger.info('%s - Started', id)
    }

    private onEnd(id: string) {
        logger.info('%s - Done', id)
    }

    private onFailure(id: string, message: string) {
        logger.error('%s - Failed: %s', id, message)
    }

    private onError(id: string, error: any) {
        logger.error('%s - %s', id, error)
    }
}