import {FSWatcher} from 'chokidar'
import {ffprobe} from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import * as path from 'path'
import {LoggerFactory} from './logger'
import {InputMedia} from './media'
import {InputConfig} from './profile'

const logger = LoggerFactory.get('watcher')

export type WatcherCallback = (input: InputMedia) => void

export class Watcher {

    private readonly config: InputConfig
    private readonly callback: (input: InputMedia) => void

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
            .on('add', path => this.onAddFile(path))
            .on('addDir', path => this.onAddDirectory(path))
            .on('unlinkDir', path => this.onRemoveDirectory(path))

        process.on('exit', () => this.watcher.close())

        this.filters.push(
            new ExcludeListFilter(config),
            new ExtensionFilter(config)
        )
    }

    watch(...paths: string[]) {
        this.watcher.add(paths)
    }

    unwatch(...paths: string[]) {
        this.watcher.unwatch(paths)
    }

    async createInput(file: string): Promise<InputMedia> {
        return new Promise<InputMedia>((resolve, reject) => {
            const failedFilters = this.filters.filter(f => !f.test(file))
            if (failedFilters && failedFilters.length > 0) {
                return reject(failedFilters[0].reason()) // Only describe the first
            }

            ffprobe(file, ['-show_chapters'], (err, data) => {
                if (!err && data && !isNaN(data.format.duration)) {
                    return resolve(new InputMedia(0, path.parse(file), data))
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

    private onAddFile(file: string) {
        this.createInput(file)
            .then(input => this.callback(input))
            .catch(reason => logger.warn("'%s' has been ignored: %s", file, reason))
    }

    private onAddDirectory(path: string) {
        logger.info("Watching: '%s' ...", path)
        this.watcher.add(path)
    }

    private onRemoveDirectory(path: string) {
        logger.info("Unwatching: '%s'", path)
        this.watcher.unwatch(path)
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