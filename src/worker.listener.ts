import * as fs from 'fs-extra'
import * as moment from 'moment'
import {Duration, Moment} from 'moment'
import * as path from 'path'
import * as winston from 'winston'
import {format} from 'winston'
import {LoggerFactory} from './logger'
import {InputStream} from './media'
import {Worker} from './worker'

const logger = LoggerFactory.get('worker')

function padStart(obj: number | string, targetLenght: number, padString: string = '\u0020'): string {
    const s = obj.toString()
    return padString.repeat(targetLenght - s.length) + s
}

export abstract class WorkerListener {

    protected worker: Worker

    protected constructor(worker: Worker) {
        this.worker = worker
    }
}

export class LoggingWorkerListener extends WorkerListener {

    private readonly outputLines: string[] = []

    constructor(worker: Worker) {
        super(worker)

        worker.on('start', commandLine => this.onStart(commandLine))
        worker.on('end', () => this.onEnd())
        worker.on('line', line => this.onLine(line))
        worker.on('error', () => this.onFailed())
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

        if (this.worker.profile.output.writeLog) {
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
        const directory = this.worker.profile.output.directory
        const filename = `${this.worker.input.path.filename}.${moment().format('YYYYMMDD-HHmmssSSS')}.log`

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

export class ProgressWorkerListener extends WorkerListener {

    startTime?: Moment
    endTime?: Moment

    inputFramerate?: number
    inputDuration?: Duration

    progress: number = -1
    progressStep: number = 5

    constructor(worker: Worker) {
        super(worker)

        worker.on('start', () => this.onStart())
        worker.on('progress', progress => this.onProgress(progress))
        worker.on('end', () => this.onEnd())
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

    onStart() {
        this.startTime = moment()

        let videoStreams: InputStream[] = this.worker.input.streams.filter(s => s.avg_frame_rate !== '0/0')
        if (videoStreams && videoStreams.length > 0) {
            let avgFramerate: string = videoStreams[0].avg_frame_rate
            let avgFramerateFrac: number[] = avgFramerate.split('/').map(f => parseInt(f))
            this.inputFramerate = avgFramerateFrac[0] / avgFramerateFrac[1]
        }
        else {
            this.inputFramerate = 1 // to avoid division by 0
            logger.debug('Unable to calculate the framerate, using default (%s)', this.inputFramerate)
        }

        if (this.worker.input.format && this.worker.input.format.duration) {
            this.inputDuration = moment.duration(this.worker.input.format.duration, 'seconds')
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
                ProgressWorkerListener.formatDuration(elapsed),
                ProgressWorkerListener.formatDuration(eta),
                ProgressWorkerListener.formatSpeed(speed)
            )

            this.progress = percent
        }
    }

    onEnd() {
        this.endTime = moment()
        logger.info('Tooks %s', moment.duration(this.endTime.diff(this.startTime)).format('d[d] HH:mm:ss.SSS'))
    }
}

export class PostWorkerListener extends WorkerListener {

    private readonly lockFile: string

    constructor(worker: Worker) {
        super(worker)

        worker.on('end', () => this.onEnd())
        worker.on('error', () => this.onFailed())

        this.lockFile = path.resolve(this.worker.profile.output.directory, 'exclude.list')
    }

    onEnd() {
        // Defines the owner if defined
        if (process.env.UID && process.env.GID) {
            this.worker.outputs
                .map(o => o.resolvePath(this.worker.profile.output.directory))
                .forEach(p => fs.chownSync(p, parseInt(process.env.UID), parseInt(process.env.GID)))
        }

        // Register the created files in 'exclude.list'
        const inputFile = this.worker.input.resolvePath(this.worker.profile.input.directory)
        this.register(inputFile).catch(reason => {
            // TODO Save the filename and retry later
            logger.warn("Failed to write in the exclude.list: %s", reason)
            logger.warn("Requires to be append manually: '%s'", inputFile)
        })
    }

    onFailed() {
        // noinspection JSIgnoredPromiseFromCall
        return this.deleteIncompleteFiles().catch(reason => logger.warn(reason))
    }

    private async register(file: string) {
        return fs.appendFile(this.lockFile, file + '\n')
    }

    private async deleteIncompleteFiles() {
        return this.worker.outputs
            .map(o => o.resolvePath(this.worker.profile.output.directory))
            .forEach(f => this.deleteFileIfPresent(f))
    }

    private deleteFileIfPresent(file: string) {
        fs.stat(file, se => {
            if (se) return

            fs.unlink(file, ue => {
                if (ue) return
            })
        })
    }
}