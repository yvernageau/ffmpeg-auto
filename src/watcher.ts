import {FSWatcher} from 'chokidar'
import {EventEmitter} from 'events'
import {ffprobe} from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import * as path from 'path'
import {LoggerFactory} from './logger'
import {InputConfig} from './profile'

const logger = LoggerFactory.get('watcher')

export class Watcher extends EventEmitter {

    private static readonly TIMEOUT = 60 * 1000

    private readonly config: InputConfig

    private readonly watcher: FSWatcher
    private readonly filters: AsyncFileFilter[] = []

    private pendingTimer: any
    private pendingFiles: string[] = []

    constructor(config: InputConfig, watch: boolean) {
        super()

        // TODO Move to configuration validator
        if (!config) {
            throw new Error(`Missing 'input' in profile, all files are excluded by default`)
        }
        else if (!config.include && !config.exclude) {
            throw new Error(`Missing 'input.includes' or 'input.excludes' in profile, all files are excluded by default`)
        }

        this.config = config

        // Add default filters
        this.filters.push(
            new ExcludeListFilter(config),
            new ExtensionFilter(config),
            new FFProbeFilter()
        )

        // Initialize the directory watcher
        this.watcher = new FSWatcher(
            {
                awaitWriteFinish: true,
                alwaysStat: true,
                ignorePermissionErrors: true,
                persistent: watch
            })
            .on('add', file => this.onAdd(file))
            .on('unlink', file => this.onRemove(file))
            .on('change', file => this.onChange(file))

        process.on('exit', () => this.watcher.close())
    }

    watch(directory: string) {
        logger.info('Watching %s ...', directory)
        this.watcher.add(directory)
    }

    unwatch(directory: string) {
        this.watcher.unwatch(directory)
    }

    private onAdd(file: string) {
        this.pendingFiles.push(file)
        logger.debug("ADD   : '%s'", file)
        this.updateTimeout()
    }

    private onRemove(file: string) {
        const index = this.pendingFiles.indexOf(file)
        if (index > -1) {
            this.pendingFiles.splice(index)
            logger.debug("REMOVE: '%s'", file)
            this.updateTimeout()
        }
        this.emit('cancel', file)
    }

    private onChange(file: string) {
        const index = this.pendingFiles.indexOf(file)
        if (index > -1) {
            logger.debug("CHANGE: '%s'", file)
            this.updateTimeout()
        }
    }

    /**
     * Updates the timeout before sending notifications for new files.
     */
    private updateTimeout(timeout: number = Watcher.TIMEOUT) {
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer)
        }

        if (this.pendingFiles.length > 0) {
            this.pendingTimer = setTimeout(() => this.notify(), timeout)
            logger.debug('Waiting %d seconds for stabilization ...', timeout / 1000)
        }
    }

    /**
     * Resets the pending files and timer to their initial state.
     */
    private reset() {
        this.pendingFiles = []

        clearTimeout(this.pendingTimer)
        this.pendingTimer = undefined
    }

    /**
     * Notifies all listeners.
     */
    private async notify() {
        // TODO Regroups external resources (same base name) and includes them as input (subtitles + audio -> container)
        const sortedFiles = this.pendingFiles.sort()

        for (let file of sortedFiles) {
            await this.filter(file)
                .then(included => {
                    if (included) {
                        this.emit('schedule', file)
                    }
                    else {
                        logger.debug("IGNORE: '%s'", file)
                    }
                })
                .catch(reason => logger.warn("IGNORE: '%s': %s", file, reason))
        }

        this.reset()
    }

    private async filter(file: string): Promise<boolean> {
        return await Promise.all(this.filters.map(f => f.test(file))).then(results => results.every(value => value))
    }
}

// region Filters

interface AsyncFileFilter {

    test(file: string): Promise<boolean>
}

/**
 * File has already been processed (registered in 'exclude.list')
 */
class ExcludeListFilter implements AsyncFileFilter {

    private readonly directory: string

    constructor(config: InputConfig) {
        this.directory = config.directory
    }

    async test(file: string): Promise<boolean> {
        const excludesListPath = path.resolve(this.directory, 'exclude.list')

        return fs.stat(excludesListPath)
            .then(stat => {
                if (!stat) { // 'excludes.list' does not exist
                    return true
                }

                let lines = fs.readFileSync(excludesListPath, {encoding: 'utf-8'}).split('\n')
                return !lines.filter(l => l === path.relative(this.directory, file))
            })
            .catch(() => true)
    }
}

/**
 * File extension is excluded in profile (input.include | input.exclude).
 */
class ExtensionFilter implements AsyncFileFilter {

    private readonly include: RegExp
    private readonly exclude: RegExp

    constructor(config: InputConfig) {
        this.include = config.include
        this.exclude = config.exclude
    }

    async test(file: string): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            const extension = path.parse(file).ext.replace(/^\./, '')
            return resolve(this.include && !!extension.match(`^(?:${this.include})$`) || this.exclude && !extension.match(`^(?:${this.exclude})$`))
        })
    }
}

/**
 * File cannot be read by ffprobe.
 */
class FFProbeFilter implements AsyncFileFilter {

    async test(file: string): Promise<boolean> {
        return new Promise<boolean>(resolve => ffprobe(file, ['-show_chapters'], (err, data) => resolve(!err && data && !isNaN(data.format.duration))))
    }
}

// endregion