import {FSWatcher} from 'chokidar'
import {EventEmitter} from 'events'
import {LoggerFactory} from './logger'
import {Profile} from './profile'
import {AsyncFileFilter, ExcludeListFilter, ExtensionFilter, FFProbeFilter} from './watcher.filter'

const logger = LoggerFactory.get('watcher')

export class Watcher extends EventEmitter {

    private static readonly TIMEOUT = 60 * 1000

    private readonly profile: Profile

    private readonly watcher: FSWatcher
    private readonly filters: AsyncFileFilter[] = []

    private pendingTimer: any
    private pendingFiles: string[] = []

    constructor(profile: Profile, watch: boolean) {
        super()

        this.profile = profile

        // Add default filters
        this.filters.push(
            new ExcludeListFilter(profile.output),
            new ExtensionFilter(profile.input),
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
