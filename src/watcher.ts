import {FSWatcher} from 'chokidar'
import {EventEmitter} from 'events'
import {LoggerFactory} from './logger'
import {Profile} from './profile'
import {AsyncFileFilter, ExcludeListFilter, ExtensionFilter, FFProbeFilter} from './watcher.filter'

const logger = LoggerFactory.get('watcher');

export class Watcher extends EventEmitter {

    private static readonly TIMEOUT = 60 * 1000;

    private readonly profile: Profile;

    private readonly watcher: FSWatcher;
    private readonly filters: AsyncFileFilter[] = [];

    private pendingTimer: any;
    private pendingFiles: string[] = [];

    constructor(profile: Profile, watch: boolean) {
        super();

        this.profile = profile;

        // Add default filters
        this.filters.push(
            new ExcludeListFilter(profile.output),
            new ExtensionFilter(profile.input),
            new FFProbeFilter()
        );

        // Initialize the directory watcher
        this.watcher = new FSWatcher(
            {
                awaitWriteFinish: true,
                alwaysStat: true,
                persistent: watch
            })
            .on('add', file => this.onAdd(file))
            .on('unlink', file => this.onRemove(file));

        process.on('exit', () => this.watcher.close())
    }

    watch(directory: string) {
        logger.info('Watching %s ...', directory);
        this.watcher.add(directory)
    }

    unwatch(directory: string) {
        this.watcher.unwatch(directory)
    }

    private onAdd(file: string) {
        this.pendingFiles.push(file);
        logger.debug("+ '%s'", file);
        this.updateTimeout()
    }

    private onRemove(file: string) {
        const index = this.pendingFiles.indexOf(file);
        if (index > -1) {
            this.pendingFiles.splice(index);
            logger.debug("- '%s'", file);
            this.updateTimeout()
        }
        this.emit('remove', file);
        this.unwatch(file)
    }

    /**
     * Updates the timeout before sending notifications for new files.
     */
    private updateTimeout(timeout: number = Watcher.TIMEOUT) {
        let waiting: boolean = false;

        if (this.pendingTimer) {
            waiting = true;
            clearTimeout(this.pendingTimer)
        }

        if (this.pendingFiles.length > 0) {
            this.pendingTimer = setTimeout(() => this.notify(), timeout);

            if (!waiting) {
                logger.debug('Waiting for stabilization before processing ...')
            }
        }
    }

    /**
     * Resets the pending files and timer to their initial state.
     */
    private reset() {
        this.pendingFiles = [];

        clearTimeout(this.pendingTimer);
        this.pendingTimer = undefined
    }

    private async filter(file: string): Promise<void> {
        return await Promise.all(this.filters.map(f => f.test(file))).then(() => {
        })
    }

    /**
     * Notifies all listeners.
     */
    private async notify() {
        // TODO Regroups external resources (same base name) and includes them as input (subtitles + audio -> container)
        for (let file of this.pendingFiles.sort()) {
            await this.filter(file)
                .then(() => this.emit('add', file))
                .catch(reason => logger.debug("x '%s': %s", file, reason))
        }

        this.reset()
    }
}
