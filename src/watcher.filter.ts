import {ffprobe} from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import * as path from "path"
import {InputConfig, OutputConfig} from './profile'

export interface AsyncFileFilter {

    test(file: string): Promise<boolean>
}

/**
 * File has already been processed (registered in 'exclude.list')
 */
export class ExcludeListFilter implements AsyncFileFilter {

    private readonly directory: string

    constructor(config: OutputConfig) {
        this.directory = config.directory
    }

    async test(file: string): Promise<boolean> {
        const excludeListPath = path.resolve(this.directory, 'exclude.list')

        return fs.stat(excludeListPath)
            .then(stat => {
                if (!stat) { // 'exclude.list' does not exist
                    return true
                }

                let lines = fs.readFileSync(excludeListPath, {encoding: 'utf-8'}).split('\n')
                return !lines.filter(l => l === file)
            })
            .catch(() => true)
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
export class FFProbeFilter implements AsyncFileFilter {

    async test(file: string): Promise<boolean> {
        return new Promise<boolean>(resolve => ffprobe(file, ['-show_chapters'], (err, data) => resolve(!err && !!data)))
    }
}