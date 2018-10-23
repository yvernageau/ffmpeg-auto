import {FSWatcher} from 'chokidar'
import {ffprobe} from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import * as path from 'path'
import {LoggerFactory} from './logger'
import {InputMedia} from './media'
import {InputConfig} from './profile'

const logger = LoggerFactory.createDefault('watcher')

export type WatcherCallback = (input: InputMedia) => void

export class Watcher {

    private pendingTimer: any
    private pendingFiles: string[] = []

    private readonly config: InputConfig
    private readonly callback: WatcherCallback

    private readonly watcher: FSWatcher
    private readonly filters: FileFilter[] = []

    constructor(config: InputConfig, watch: boolean, callback: WatcherCallback) {
        // TODO Move to configuration validator
        if (!config) {
            throw new Error(`Missing 'input' in profile, all files are excluded by default`)
        }
        else if (!config.include && !config.exclude) {
            throw new Error(`Missing 'input.includes' or 'input.excludes' in profile, all files are excluded by default`)
        }

        this.config = config
        this.callback = callback

        this.watcher = new FSWatcher(
            {
                awaitWriteFinish: true,
                alwaysStat: true,
                ignorePermissionErrors: true,
                persistent: watch
            })
            .on('add', path => this.onAdd(path))
            .on('unlink', path => this.onRemove(path))
            .on('change', path => this.onChange(path))

        process.on('exit', () => this.watcher.close())

        this.filters.push(
            new ExcludeListFilter(config),
            new ExtensionFilter(config)
        )
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
        logger.debug("Added '%s' ...")
        this.restartTimer()
    }

    private onRemove(file: string) {
        const index = this.pendingFiles.indexOf(file)
        if (index > -1) {
            this.pendingFiles.splice(index)
            logger.debug("Removed '%s' ...")
            this.restartTimer()
        }
    }

    private onChange(file: string) {
        this.restartTimer()
    }

    private restartTimer() {
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer)
        }
        this.pendingTimer = setTimeout(() => this.notifyPendingFiles(), 60000)
    }

    private notifyPendingFiles() {
        // TODO Regroups external resources (same base name) and includes them as input (subtitles + audio -> container)
        this.pendingFiles.sort().forEach(p => this.filterAndCreateInput(p).then(input => this.callback(input)))

        // Clear the pending files and timer
        this.pendingFiles = []

        clearTimeout(this.pendingTimer)
        this.pendingTimer = undefined
    }

    private async filterAndCreateInput(file: string): Promise<InputMedia> {
        return new Promise<InputMedia>((resolve, reject) => {
            const failedFilters = this.filters.filter(f => !f.test(file))
            if (failedFilters && failedFilters.length > 0) {
                return reject(failedFilters[0].reason()) // Only describe the first
            }

            ffprobe(file, ['-show_chapters'], (err, data) => {
                if (!err && data && !isNaN(data.format.duration)) {
                    let filepath = path.parse(file)

                    return resolve(new InputMedia(
                        0,
                        {
                            parent: filepath.dir,
                            filename: filepath.name,
                            extension: filepath.ext.replace(/^\./, '')
                        },
                        data
                    ))
                }
                else if (err) {
                    return reject(err.message)
                }
                else {
                    return reject('File is not a media')
                }
            })
        })
    }
}

interface FileFilter {

    reason(): string

    test(file: string): boolean
}

class ExcludeListFilter implements FileFilter {

    private readonly directory: string

    constructor(config: InputConfig) {
        this.directory = config.directory
    }

    reason(): string {
        return "File has already been processed (registered in 'excludes.list')"
    }

    test(file: string): boolean {
        const excludesListPath = path.resolve(this.directory, 'excludes.list')

        // Excluded by default
        let included: boolean = false

        try {
            const stats = fs.statSync(excludesListPath)
            if (!stats) { // Excludes list does not exist
                included = true
            }
            else {
                let lines = fs.readFileSync(excludesListPath, {encoding: 'utf-8'}).split('\n')
                included = !lines.filter(l => l === path.relative(this.directory, file))
            }
        }
        catch (e) {
            included = true
        }

        return included
    }
}

class ExtensionFilter implements FileFilter {

    private readonly include: RegExp
    private readonly exclude: RegExp

    constructor(config: InputConfig) {
        this.include = config.include
        this.exclude = config.exclude
    }

    reason(): string {
        return "File extension is excluded in profile (input.include | input.exclude)"
    }

    test(file: string): boolean {
        const extension = path.parse(file).ext.replace(/^\./, '')

        // Excluded by default
        let included: boolean = false

        if (this.include) {
            included = !!extension.match(new RegExp(`^(?:${this.include})$`))
        }

        if (this.exclude) {
            included = !extension.match(new RegExp(`^(?:${this.exclude})$`))
        }

        return included
    }
}