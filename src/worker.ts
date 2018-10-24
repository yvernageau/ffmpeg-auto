import {EventEmitter} from 'events'
import * as ffmpeg from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import 'moment-duration-format'
import * as path from 'path'
import {LoggerFactory} from './logger'
import {InputMedia, OutputMedia} from './media'
import {OutputMediaBuilder} from './media.builder'
import {Profile} from './profile'
import {DefaultSnippetResolver} from './snippet'
import {LoggingWorkerListener, PostWorkerListener, ProgressWorkerListener} from './worker.listener'

const logger = LoggerFactory.get('worker')

type FFMpegProgress = {
    frames: number,
    currentFps: number,
    currentKbps: number,
    targetSize: number,
    timemark: number,
    percent: number
}

export class Worker extends EventEmitter {

    readonly profile: Profile
    readonly input: InputMedia
    readonly outputs: OutputMedia[]

    private locked: boolean

    constructor(profile: Profile, input: InputMedia) {
        super()

        this.profile = profile
        this.input = input

        this.outputs = new OutputMediaBuilder().build({
            profile: this.profile,
            input: this.input
        })

        // Register the default listeners
        new LoggingWorkerListener(this)
        new ProgressWorkerListener(this)
        new PostWorkerListener(this)
    }

    async execute() {
        if (this.locked) {
            return Promise.reject('This execution has already been done')
        }
        this.locked = true

        return new Promise((resolve, reject) => {
            let command = ffmpeg()

            // Configure input
            let inputOptions: string[] = []
            if (this.profile.input && this.profile.input.params) {
                inputOptions = new DefaultSnippetResolver().resolve(this.profile.input.params, {
                    profile: this.profile,
                    input: this.input
                }).split(/\s+/)
            }

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
                this.createDirectories(outputPath)

                logger.debug('output:%d = %s', o.id, outputPath)
                logger.debug('output:%d.options = %s', o.id, outputOptions.join(' '))

                command.output(outputPath)
                if (outputOptions && outputOptions.length > 0) {
                    command.outputOptions(...outputOptions)
                }
            })

            // Configure events
            command
                .on('start', (commandLine: string) => {
                    this.emit('start', commandLine)
                })
                .on('progress', (progress: FFMpegProgress) => {
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

            command.run()
        })
    }

    private createDirectories(outputPath: string, baseDirectory: string = this.profile.output.directory) {
        // Create missing directories
        fs.mkdirpSync(path.dirname(outputPath))

        // Set owner (if defined)
        if (process.env.UID && process.env.GID) {
            const uid = parseInt(process.env.UID)
            const gid = parseInt(process.env.GID)

            const parentDirectory = baseDirectory.replace(`${path.sep}$`, '') // Remove the tailing separator
            let currentDirectory = path.dirname(outputPath)
            while (currentDirectory !== parentDirectory) {
                const stat = fs.statSync(currentDirectory)
                if (stat.uid !== uid || stat.gid !== gid) { // Ensure the owner is not already defined
                    logger.debug("Set owner (%d:%d) of '%s'", uid, gid, currentDirectory)
                    fs.chownSync(currentDirectory, uid, gid)
                }
                currentDirectory = path.dirname(currentDirectory)
            }
        }
    }
}
