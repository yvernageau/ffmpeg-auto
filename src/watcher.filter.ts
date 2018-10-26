import {ffprobe} from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import * as path from "path"
import {InputConfig, OutputConfig} from './profile'

export interface AsyncFileFilter {

    /**
     * @return an detailed error when the file failed the test
     */
    test(file: string): Promise<void>
}

/**
 * File has already been processed (registered in 'exclude.list')
 */
export class ExcludeListFilter implements AsyncFileFilter {

    private readonly directory: string

    constructor(config: OutputConfig) {
        this.directory = config.directory
    }

    async test(file: string): Promise<void> {
        const excludeListPath = path.resolve(this.directory, 'exclude.list')

        return fs.stat(excludeListPath)
            .then(stat => {
                if (!stat) { // 'exclude.list' does not exist
                    return Promise.resolve()
                }

                let lines = fs.readFileSync(excludeListPath, {encoding: 'utf-8'}).split('\n')
                if (lines.filter(l => l === file).length > 0) {
                    return Promise.reject(`'${file}' has already been processed`)
                }
                else {
                    return Promise.resolve()
                }
            })
    }
}

/**
 * File extension is excluded in profile (input.include | input.exclude).
 */
export class ExtensionFilter implements AsyncFileFilter {

    private readonly include: RegExp
    private readonly exclude: RegExp

    constructor(config: InputConfig) {
        this.include = config.include
        this.exclude = config.exclude
    }

    async test(file: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const extension = path.parse(file).ext.replace(/^\./, '')
            if (this.include && !!extension.match(`^(?:${this.include})$`) || this.exclude && !extension.match(`^(?:${this.exclude})$`)) {
                resolve()
            }
            else {
                reject(`'${file}' is excluded (or not included) in the 'profile.input' configuration`)
            }
        })
    }
}

/**
 * File cannot be read by ffprobe.
 */
export class FFProbeFilter implements AsyncFileFilter {

    async test(file: string): Promise<void> {
        return new Promise<void>((resolve, reject) => ffprobe(file, ['-show_chapters'], (err, data) => {
            if (!err && !!data) {
                resolve()
            }
            else if (err) {
                reject(err.message)
            }
            else {
                reject(`'${file}' is not supported: ffprobe returns no data`)
            }
        }))
    }
}