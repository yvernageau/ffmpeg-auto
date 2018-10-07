import * as ffmpeg from 'fluent-ffmpeg'
import * as fs from "fs-extra"
import * as moment from 'moment'
import {Duration, Moment} from 'moment'
import 'moment-duration-format'
import * as path from "path"
import {LoggerFactory} from './logger'
import {InputMedia, OutputMedia} from './media'
import {MediaBuilder} from './media.builder'
import {Profile} from './profile'
import {DefaultSnippetResolver} from './snippet'

const logger = LoggerFactory.get('ffmpeg')

function padStart(obj: number | string, targetLenght: number, padString: string = '\u0020'): string {
    const s = obj.toString()
    return padString.repeat(targetLenght - s.length) + s
}

export class Executor {

    private readonly profile: Profile
    private readonly input: InputMedia
    private readonly outputs: OutputMedia[]

    private lock: boolean

    private startTime: Moment
    private endTime: Moment

    private framerate: number
    private duration: Duration

    private progress: number = -1
    private progressPad: number = 1

    constructor(profile: Profile, input: InputMedia) {
        this.profile = profile
        this.input = input
        this.outputs = new MediaBuilder().build({profile: profile, input: input})
    }

    async execute() {
        if (this.lock) {
            return Promise.reject('This execution has already been done')
        }
        this.lock = true

        return new Promise((resolve, reject) => {
            // Configure input
            let command = ffmpeg().input(this.input.resolvePath())

            if (this.profile.input && this.profile.input.params) {
                command.inputOption(new DefaultSnippetResolver().resolve(this.profile.input.params, {
                    profile: this.profile,
                    input: this.input
                }))
            }

            // Configure output(s)
            this.outputs.forEach(o => {
                const globalOptions: string[] = o.params
                    .map(a => a.trim().split(' '))
                    .reduce((a, b) => a.concat(...b), [])

                const streamOptions: string[] = o.streams
                    .map(os => os.params)
                    .reduce((a, b) => a.concat(...b), [])
                    .map(a => (<string>a).trim().split(' '))
                    .reduce((a, b) => a.concat(...b), [])

                const outputPath = o.resolvePath()
                fs.mkdirpSync(path.parse(outputPath).dir)

                command.output(outputPath).outputOptions(...streamOptions, ...globalOptions)
            })

            // Configure events
            command
                .on('start', cl => this.onStart(cl))
                .on('progress', (progress) => this.onProgress(progress))
                .on('stderr', line => {
                    if (line.search(/frame=\s*\d+/) < 0) { // Skip progress
                        this.onLine(line)
                    }
                })
                .on('end', (stdout, stderr) => {
                    this.onEnd(stderr)
                    resolve()
                })
                .on('error', (err, stdout, stderr) => {
                    command.kill('SIGINT')
                    this.onFailed(stderr)
                    reject(err.message)
                })

            command.run()
        })
    }

    onStart(commandLine: string) {
        this.startTime = moment()

        try {
            const avgFramerate: string = this.input.streams.filter(s => s.avg_frame_rate !== '0/0')[0].avg_frame_rate
            const avgFramerateFrac: number[] = avgFramerate.split('/').map(f => parseInt(f))
            this.framerate = avgFramerateFrac[0] / avgFramerateFrac[1]
        }
        catch (e) {
            logger.debug('Unable to calculate the framerate')
            this.framerate = 1 // to avoid division by 0
        }

        try {
            this.duration = moment.duration(this.input.format.duration, 'seconds')
        }
        catch (e) {
            logger.debug('Unable to calculate the duration')
            this.duration = moment.duration(0, 'seconds')
        }

        logger.info('Executing: %s', commandLine)
    }

    // noinspection JSMethodCanBeStatic
    onLine(line: string) {
        logger.debug(line)
    }

    onProgress(progress: any) {
        let percent = Math.floor(progress.percent)
        if (percent > this.progress && percent % this.progressPad === 0) {

            const speed = progress.currentFps / this.framerate

            const elapsed = moment.duration(moment().diff(this.startTime), 'milliseconds')
            const elapsedStr = elapsed.format('HH:mm:ss', {trim: false, forceLength: true})

            const eta = moment.duration((100 - progress.percent) / 100 * this.duration.asSeconds() * (1 / speed), 'seconds')
            const etaStr = isFinite(eta.asSeconds())
                ? eta.format('HH:mm:ss', {trim: false, forceLength: true})
                : '--:--:--'

            logger.info(
                '%s%% : %sfps [%s @ %s] ; Elapsed: %s ; ETA: %s ; x%s',
                padStart(percent, 3),
                padStart(progress.currentFps, 4),
                padStart(progress.frames, 6),
                progress.timemark,
                elapsedStr,
                etaStr,
                speed.toFixed(3)
            )

            this.progress = percent
        }
    }

    onEnd(stderr: string) {
        this.endTime = moment()

        if (this.profile.output.writeLog) {
            this.writeLog(stderr).catch((reason) => {
                logger.error('Failed to write log file: %s', reason)
                logger.info(stderr)
            })
        }

        const inputFile = path.relative(this.profile.input.directory, this.input.resolvePath())
        const lockFile = path.resolve(this.profile.output.directory, '.lock')
        fs.appendFile(lockFile, inputFile).catch(reason => logger.warn('Cannot write filename in %s : %s', lockFile, reason))

        logger.info('Transcoding succeeded. Tooks %ds', moment.duration(this.endTime.diff(this.startTime)).format('d[d] HH:mm:ss.SSS'))
    }

    onFailed(stderr: string) {
        logger.error('')
        this.writeLog(stderr)
            .then(logFile => {
                logger.error('Transcoding failed! For more details, see log at %s', logFile)
            })
            .catch(() => {
                logger.error(stderr)
                logger.error('Transcoding failed!')
            })

        // noinspection JSIgnoredPromiseFromCall
        this.cleanOutputs()
    }

    private async cleanOutputs() {
        this.outputs
            .map(o => o.resolvePath())
            .forEach(f => {
                fs.stat(f, e => {
                    if (e) return
                    fs.unlink(f, (e2) => {
                        if (e2) return
                    })
                })
            })
    }

    private async writeLog(content: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            let datetime = new Date().toLocaleString().replace(/[ :-]/g, '')
            let logFile = path.resolve(this.profile.output.directory, `${this.input.path.filename}.${datetime}.log`)

            let lines = content.split(/\r\n|\r|\n/).filter(s => s.trim()).join('\r\n')

            fs.writeFile(logFile, lines, e => {
                // FIXME 'strerr' is not completely written in log file
                if (e) return reject(e)
            })

            return resolve(logFile)
        })
    }
}
