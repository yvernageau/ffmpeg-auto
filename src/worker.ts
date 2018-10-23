import * as ffmpeg from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import * as moment from 'moment'
import {Duration, Moment} from 'moment'
import 'moment-duration-format'
import * as path from "path"
import * as winston from 'winston'
import {format} from 'winston'
import {LoggerFactory} from './logger'
import {InputMedia, InputStream, OutputMedia} from './media'
import {MediaBuilder} from './media.builder'
import {Profile} from './profile'
import {DefaultSnippetResolver} from './snippet'

const logger = LoggerFactory.createDefault('ffmpeg')

export class Worker {

    readonly profile: Profile
    readonly input: InputMedia
    readonly outputs: OutputMedia[]

    private locked: boolean

    private listeners: ExecutorListener[] = []

    constructor(profile: Profile, input: InputMedia) {
        this.profile = profile
        this.input = input

        this.outputs = new MediaBuilder().build({
            profile: this.profile,
            input: this.input
        })

        this.listeners.push(
            new LoggingExecutorListener(this),
            new ProgressExecutorListener(this),
            new PostExecutorListener(this)
        )
    }

    async execute() {
        if (this.locked) {
            return Promise.reject('This execution has already been done')
        }
        this.locked = true

        return new Promise((resolve, reject) => {
            // Configure input
            let command = ffmpeg()

            let inputOptions: string[] = []
            if (this.profile.input && this.profile.input.params) {
                inputOptions = new DefaultSnippetResolver().resolve(this.profile.input.params, {
                    profile: this.profile,
                    input: this.input
                }).split(/\s+/)
            }

            const inputPath = this.input.resolvePath()

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

                const outputPath = o.resolvePath()
                fs.mkdirpSync(path.parse(outputPath).dir)

                logger.debug('output:%d = %s', o.id, outputPath)
                logger.debug('output:%d.options = %s', o.id, outputOptions.join(' '))

                command.output(outputPath)
                if (outputOptions && outputOptions.length > 0) {
                    command.outputOptions(...outputOptions)
                }
            })

            // Configure events
            command
                .on('start', cl => {
                    this.listeners.forEach(l => l.onStart(cl))
                })
                .on('progress', progress => {
                    this.listeners.forEach(l => l.onProgress(progress))
                })
                .on('stderr', (line: string) => {
                    if (!line.match(/^frame=\s*\d+/) && !line.match(/Press /)) { // Skip progress and prompt
                        this.listeners.forEach(l => l.onLine(line))
                    }
                })
                .on('end', () => {
                    this.listeners.forEach(l => l.onEnd())
                    resolve()
                })
                .on('error', err => {
                    command.kill('SIGINT')
                    this.listeners.forEach(l => l.onFailed())
                    reject(err.message) // TODO Remove tailing return-line
                })

            command.run()
        })
    }
}

export abstract class ExecutorListener {

    protected executor: Worker

    protected constructor(executor: Worker) {
        this.executor = executor
    }

    onStart(commandLine: string) {
        // Do nothing
    }

    onLine(line: string) {
        // Do nothing
    }

    onProgress(progress: any) {
        // Do nothing
    }

    onEnd() {
        // Do nothing
    }

    onFailed() {
        // Do nothing
    }
}

export class LoggingExecutorListener extends ExecutorListener {

    private readonly outputLines: string[] = []

    constructor(executor: Worker) {
        super(executor)
    }

    onStart(commandLine: string) {
        logger.info('Executing: $ %s', commandLine)

        this.outputLines.push('$ ' + commandLine)
        this.outputLines.push('')
    }

    onLine(line: string) {
        logger.debug(line)

        this.outputLines.push(line)
    }

    onEnd() {
        logger.info('Transcoding succeeded')

        if (this.executor.profile.output.writeLog) {
            let logFile = this.writeLogFile('info', this.outputLines)
            logger.info('Log written at %s', logFile)
        }
    }

    onFailed() {
        logger.error('Transcoding failed')

        let logFile = this.writeLogFile('error', this.outputLines)
        logger.error('For more details, see log at %s', logFile)
    }

    private writeLogFile(level: string, lines: string[]): string {
        const directory = this.executor.profile.output.directory
        const filename = `${this.executor.input.path.filename}.${moment().format('YYYYMMDD-HHmmssSSS')}.log`

        const fileLogger = winston.createLogger({
            format: format.simple(),
            level: 'info',
            transports: new winston.transports.File({
                dirname: directory,
                filename: filename,
            })
        })

        lines.forEach(l => fileLogger.log(level, l))

        return path.resolve(directory, filename)
    }
}

function padStart(obj: number | string, targetLenght: number, padString: string = '\u0020'): string {
    const s = obj.toString()
    return padString.repeat(targetLenght - s.length) + s
}

export class ProgressExecutorListener extends ExecutorListener {

    startTime?: Moment
    endTime?: Moment

    inputFramerate?: number
    inputDuration?: Duration

    progress: number = -1
    progressStep: number = 5

    constructor(executor: Worker) {
        super(executor)
    }

    private static formatDuration(duration: Duration) {
        let asSeconds = duration.asSeconds()

        return isFinite(asSeconds) && asSeconds >= 0
            ? duration.format('d[d] *HH:mm:ss', {forceLength: true})
            : '--:--:--'
    }

    private static formatSpeed(speed: number) {
        return speed.toFixed(3)
    }

    onStart(commandLine: string) {
        this.startTime = moment()

        let videoStreams: InputStream[] = this.executor.input.streams.filter(s => s.avg_frame_rate !== '0/0')
        if (videoStreams && videoStreams.length > 0) {
            let avgFramerate: string = videoStreams[0].avg_frame_rate
            let avgFramerateFrac: number[] = avgFramerate.split('/').map(f => parseInt(f))
            this.inputFramerate = avgFramerateFrac[0] / avgFramerateFrac[1]
        }
        else {
            this.inputFramerate = 1 // to avoid division by 0
            logger.debug('Unable to calculate the framerate, using default (%s)', this.inputFramerate)
        }

        if (this.executor.input.format && this.executor.input.format.duration) {
            this.inputDuration = moment.duration(this.executor.input.format.duration, 'seconds')
        }
        else {
            this.inputDuration = moment.duration(0, 'seconds')
            logger.debug('Unable to calculate the duration, using default (%ss)', this.inputDuration.asSeconds())
        }
    }

    onProgress(progress: any) {
        let percent = Math.floor(progress.percent)
        if (percent > this.progress && percent % this.progressStep === 0) {

            const speed = progress.currentFps / this.inputFramerate

            const elapsed = moment.duration(moment().diff(this.startTime), 'milliseconds')
            const eta = moment.duration((100 - progress.percent) / 100 * this.inputDuration.asSeconds() * (1 / speed), 'seconds')

            logger.info(
                '%s%% [%s @ %s] FPS: %s ; Elapsed: %s ; ETA: %s ; Speed: x%s',
                padStart(percent, 3),
                padStart(progress.frames, 6),
                progress.timemark,
                padStart(progress.currentFps, 4),
                ProgressExecutorListener.formatDuration(elapsed),
                ProgressExecutorListener.formatDuration(eta),
                ProgressExecutorListener.formatSpeed(speed)
            )

            this.progress = percent
        }
    }

    onEnd() {
        this.endTime = moment()
        logger.info('Tooks %s', moment.duration(this.endTime.diff(this.startTime)).format('d[d] HH:mm:ss.SSS'))
    }
}

class PostExecutorListener extends ExecutorListener {

    private readonly lockFile: string

    constructor(executor: Worker) {
        super(executor)

        this.lockFile = path.resolve(this.executor.profile.output.directory, 'excludes.list')
    }

    onEnd() {
        // Defines the owner if defined
        if (process.env.UID && process.env.GID) {
            this.executor.outputs
                .map(o => o.resolvePath())
                .forEach(p => fs.chownSync(p, parseInt(process.env.UID), parseInt(process.env.GID)))
        }

        const inputFile = path.relative(this.executor.profile.input.directory, this.executor.input.resolvePath())

        this.register(inputFile).catch(reason => {
            // TODO Save the filename and retry later
            logger.warn("Failed to write in the excludes list: %s", reason)
            logger.warn("Requires to be append manually: '%s'", inputFile)
        })
    }

    onFailed() {
        // noinspection JSIgnoredPromiseFromCall
        return this.unlinkOutputs().catch(reason => logger.warn(reason))
    }

    private async register(file: string) {
        return fs.appendFile(this.lockFile, file + '\n')
    }

    private async unlinkOutputs() {
        return this.executor.outputs
            .map(o => o.resolvePath())
            .forEach(f => this.unlinkIfPresent(f))
    }

    private unlinkIfPresent(file: string) {
        fs.stat(file, se => {
            if (se) logger.warn(se.message)

            fs.unlink(file, ue => {
                if (ue) logger.warn(ue.message)
            })
        })
    }
}
