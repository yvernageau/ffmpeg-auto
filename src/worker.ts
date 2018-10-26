import {EventEmitter} from 'events'
import * as ffmpeg from 'fluent-ffmpeg'
import {FfmpegCommand} from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import 'moment-duration-format'
import * as path from 'path'
import {LoggerFactory} from './logger'
import {InputMedia, OutputMedia, resolvePath} from './media'
import {Profile} from './profile'
import {LoggingWorkerListener, ProgressWorkerListener} from './worker.listener'

const logger = LoggerFactory.get('worker')

export type WorkerContext = {
    profile: Profile
    input: InputMedia
    outputs: OutputMedia[]
}

type WorkerDirection = 'in' | 'out'

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

        this.on('end', () => {
            new SetOwnerTask(this).execute()
            new UpdateExcludeListTask(this).execute()
            new CleanInputTask(this).execute()
        })

        this.on('error', () => {
            new CleanOutputTask(this).execute()
        })

        // Register the default listeners
        new LoggingWorkerListener(this)
        new ProgressWorkerListener(this)
    }

    async execute() {
        if (this.locked) {
            return Promise.reject('This task has already been executed')
        }
        this.locked = true

        return new Promise((resolve, reject) => {
            let command = this.outputs.reduce((c, o) => this.appendOutput(o, c), this.appendInput(this.input, ffmpeg()))

            this.addListeners(command)

            command
                .on('end', () => resolve())
                .on('error', (err: Error) => reject(err.message)) // TODO Use `command.kill()` ?
                .run()
        })
    }

    private appendInput(input: InputMedia, command: FfmpegCommand): FfmpegCommand {
        return appendArgs(
            command,
            'in',
            resolvePath(input.path, this.profile.input.directory),
            input.params,
            (c, f) => c.input(f),
            (c, os) => c.inputOption(os)
        )
    }

    private appendOutput(output: OutputMedia, command: FfmpegCommand): FfmpegCommand {
        return appendArgs(
            command,
            'out',
            resolvePath(output.path, this.profile.output.directory),
            [
                ...output.params,
                ...output.streams.map(os => os.params).reduce((a, b) => a.concat(...b), [])
            ],
            (c, f) => c.output(f),
            (c, os) => c.outputOption(os)
        )
    }

    private addListeners(command: FfmpegCommand) {
        command
            .on('start', (commandLine: string) => this.emit('start', commandLine))
            .on('progress', (progress: any) => this.emit('progress', progress))
            .on('stderr', (line: string) => {
                if (!line.match(/^frame=\s*\d+/) && !line.match(/Press /)) { // Skip progress and prompt
                    this.emit('line', line)
                }
            })
            .on('end', () => this.emit('end'))
            .on('error', (err: Error) => this.emit('error', err))
    }
}

function appendArgs(command: FfmpegCommand, direction: WorkerDirection, file: string, options: string[], setFile: (c: FfmpegCommand, f: string) => void, setOptions: (c: FfmpegCommand, os: string[]) => void): FfmpegCommand {
    logger.debug('%s = %s', direction, file)
    logger.debug('%s.options = %s', direction, options.join(' '))

    if (direction === 'out') {
        fs.mkdirpSync(path.dirname(file))
    }

    setFile(command, file)

    if (options && options.length > 0) {
        setOptions(command, options.map(a => a.trim().split(/\s+/)).reduce((a, b) => a.concat(...b), []))
    }

    return command
}

abstract class WorkerTask {

    protected readonly worker: Worker

    protected constructor(worker: Worker) {
        this.worker = worker
    }

    abstract execute(): void
}

class SetOwnerTask extends WorkerTask {

    constructor(worker: Worker) {
        super(worker)
    }

    execute() {
        if (process.env.UID && process.env.GID) {
            const uid = parseInt(process.env.UID)
            const gid = parseInt(process.env.GID)

            this.worker.outputs
                .map(o => resolvePath(o.path, this.worker.profile.output.directory))
                .forEach(p => this.setOwner(p, uid, gid))
        }
    }

    private async setOwner(file: string, uid: number, gid: number) {
        const parentDirectory = this.worker.profile.output.directory.replace(`${path.sep}$`, '') // Remove the tailing separator

        // Define the owner of the file, then its parent directories until the base directory
        let currentPath = file
        while (currentPath !== parentDirectory) {
            const stat = fs.statSync(currentPath)
            if (stat.uid !== uid || stat.gid !== gid) { // Ensure the owner is not already defined
                fs.chown(currentPath, uid, gid)
                    .then(() => logger.debug("Owner (%d:%d) defined for '%s'", uid, gid, currentPath))
                    .catch(reason => logger.warn("Cannot define the owner (%d:%d) of '%s': %s", uid, gid, file, reason))
            }
            currentPath = path.dirname(currentPath)
        }
    }
}

class UpdateExcludeListTask extends WorkerTask {

    constructor(worker: Worker) {
        super(worker)
    }

    execute() {
        const excludeList = path.resolve(this.worker.profile.output.directory, 'exclude.list')
        const file = resolvePath(this.worker.input.path, this.worker.profile.input.directory)

        fs.appendFile(excludeList, file + '\n')
            .then(() => logger.debug("'%s' registered in 'exclude.list'", file))
            .catch(reason => logger.warn("Failed to register '%s' in 'exclude.list': %s", file, reason))
    }
}

class CleanInputTask extends WorkerTask {

    constructor(worker: Worker) {
        super(worker)
    }

    execute() {
        if (this.worker.profile.input.deleteAfterProcess) {
            const file = resolvePath(this.worker.input.path, this.worker.profile.input.directory)

            fs.unlink(file)
                .then(() => logger.info("'%s' deleted (deleteAfterProcess=%s)", file, true))
                .catch(reason => logger.warn("Failed to delete '%s' (deleteAfterProcess=%s): %s", file, reason))
        }
    }
}

class CleanOutputTask extends WorkerTask {

    constructor(worker: Worker) {
        super(worker)
    }

    execute() {
        return this.worker.outputs
            .map(o => resolvePath(o.path, this.worker.profile.output.directory))
            .forEach(f => this.deleteIfPresent(f))
    }

    private deleteIfPresent(file: string) {
        if (fs.existsSync(file)) {
            fs.unlink(file, () => {
            })
        }
    }
}