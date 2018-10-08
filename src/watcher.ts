import {FSWatcher} from 'chokidar'
import {ffprobe} from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import * as path from 'path'
import {LoggerFactory} from './logger'
import {InputMedia} from './media'
import {Profile} from './profile'

const logger = LoggerFactory.get('watcher')

export class DirectoryWatcher {

    private readonly profile: Profile
    private readonly onInput: (input: InputMedia) => void

    private readonly watcher: FSWatcher

    constructor(profile: Profile, onInput: (input: InputMedia) => void, watch: boolean = false) {
        this.profile = profile
        this.onInput = onInput

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
    }

    watch(...paths: string[]) {
        this.watcher.add(paths)
    }

    unwatch(...paths: string[]) {
        this.watcher.unwatch(paths)
    }

    async createInput(file: string): Promise<InputMedia> {
        return new Promise<InputMedia>((resolve, reject) => {
            if (this.isExcludedFromList(file)) {
                return reject("File has already been processed (registered in 'excludes.list')")
            }
            else if (this.isExcludedFromProfile(file)) {
                return reject("File extension is excluded in profile")
            }
            else {
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
            }
        })
    }

    private onAddFile(file: string) {
        this.createInput(file)
            .then(input => this.onInput(input))
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

    private isExcludedFromList(file: string): boolean {
        const excludesListPath = path.resolve(this.profile.output.directory, 'excludes.list')

        try {
            let stats = fs.statSync(excludesListPath)
            if (!stats) { // Excludes list does not exist
                return false
            }
            else {
                let lines = fs.readFileSync(excludesListPath, {encoding: 'utf-8'}).split('\n')
                return !!lines.filter(l => l === path.relative(this.profile.input.directory, file))
            }
        }
        catch (e) {
            return false
        }
    }

    private isExcludedFromProfile(file: string): boolean {
        // TODO Move to configuration validator
        if (!this.profile.input) {
            throw new Error(`Missing 'input' in '${this.profile.id}', all files are excluded by default`)
        }
        else if (!this.profile.input.includes && !this.profile.input.excludes) {
            throw new Error(`Missing 'includes' or 'excludes' in '${this.profile.id}#input', all files are excluded by default`)
        }

        const extension = path.parse(file).ext.replace(/^\./, '')

        // Excluded by default
        let includes: boolean = false
        let excludes: boolean = true

        if (this.profile.input.includes) {
            includes = extension.search(this.profile.input.includes) >= 0
        }

        if (this.profile.input.excludes) {
            excludes = extension.search(this.profile.input.excludes) >= 0
        }

        return !includes && excludes
    }
}