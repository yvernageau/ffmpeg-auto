import {EventEmitter} from 'events'
import * as ffmpeg from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import 'moment-duration-format'
import * as path from 'path'
import {LoggerFactory} from './logger'
import {InputMedia, OutputMedia} from './media'
import {Profile} from './profile'
import {LoggingWorkerListener, PostWorkerListeners, ProgressWorkerListener} from './worker.listener'

const logger = LoggerFactory.get('worker')

export type WorkerContext = {
    profile: Profile
    input: InputMedia
    outputs: OutputMedia[]
}

export class Worker extends EventEmitter {

    readonly profile: Profile
    readonly input: InputMedia
    readonly outputs: OutputMedia[]

    private locked: boolean

    constructor(context: WorkerContext) {
        super()

        this.profile = context.profile
        this.input = context.input
        this.outputs = context.outputs

        // Register the default listeners
        new LoggingWorkerListener(this)
        new ProgressWorkerListener(this)

        PostWorkerListeners.subscribe(this)
    }

    async execute() {
        if (this.locked) {
            return Promise.reject('This execution has already been done')
        }
        this.locked = true

        return new Promise((resolve, reject) => {
            let command = ffmpeg()

            // Configure input
            let inputOptions: string[] = this.input.params
                .map(a => a.trim().split(/\s+/))
                .reduce((a, b) => a.concat(...b), [])

            const inputPath = this.input.resolvePath(this.profile.input.directory)

            logger.debug('input = %s', inputPath)
            logger.debug('input.options = %s', inputOptions.join(' '))

            command.input(inputPath)
            if (inputOptions && inputOptions.length > 0) {
                command.inputOption(...inputOptions)
            }

            // Configure output(s)
            this.outputs.forEach(o => {
                const globalOptions: string[] = o.params
                    .map(a => a.trim().split(/\s+/))
                    .reduce((a, b) => a.concat(...b), [])

                const streamOptions: string[] = o.streams
                    .map(os => os.params)
                    .reduce((a, b) => a.concat(...b), [])
                    .map(a => (<string>a).trim().split(/\s+/))
                    .reduce((a, b) => a.concat(...b), [])

                const outputOptions = [...streamOptions, ...globalOptions]

                // Create missing directories and set owner
                const outputPath = o.resolvePath(this.profile.output.directory)
                fs.mkdirpSync(path.dirname(outputPath))

                logger.debug('output:%d = %s', o.id, outputPath)
                logger.debug('output:%d.options = %s', o.id, outputOptions.join(' '))

                command.output(outputPath)
                if (outputOptions && outputOptions.length > 0) {
                    command.outputOptions(...outputOptions)
                }
            })

            // Configure events
            command
                .on('start', commandLine => {
                    this.emit('start', commandLine)
                })
                .on('progress', progress => {
                    this.emit('progress', progress)
                })
                .on('stderr', (line: string) => {
                    if (!line.match(/^frame=\s*\d+/) && !line.match(/Press /)) { // Skip progress and prompt
                        this.emit('line', line)
                    }
                })
                .on('end', () => {
                    this.emit('end')
                    resolve()
                })
                .on('error', (err: Error) => {
                    command.kill('SIGINT')
                    this.emit('error', err)
                    reject(err.message.split(/([\r\n]|\r\n)$/).map(l => l.trim()).filter(l => l).join('\n'))
                })

            // Execute command
            command.run()
        })
    }
}
