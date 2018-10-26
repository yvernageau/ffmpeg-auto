import * as fs from 'fs-extra'
import {CodecType} from './media'
import {Snippet, Snippets} from './snippet'

export class Profile {
    [key: string]: any

    id: string
    input: InputConfig
    output: OutputConfig

    static load(path: string): Profile {
        return {
            ...new Profile(),
            ...JSON.parse(fs.readFileSync(path, 'utf-8'))
        }
    }
}

export class IOConfig {
    directory: string
}

export class InputConfig extends IOConfig {
    include?: RegExp
    exclude?: RegExp
    params?: Snippets = []
    deleteAfterProcess?: boolean
}

// TODO Support for filters (filter_complex)
export class OutputConfig extends IOConfig {
    defaultExtension?: string = 'mkv'
    writeLog?: boolean = false
    mappings: Mapping[] = []
}

export class Task {
    id?: string
    on?: StreamSelector
    when?: Snippets = 'true'
    skip?: boolean = false
    params?: Snippets = []
}

export class Mapping extends Task {
    output: Snippet = '{fn}'
    format?: string
    options?: Option[] = []
}

export class Option extends Task {
    exclude: boolean
}

export type StreamSelector = 'all' | 'none' | 'chapters' | CodecType | CodecType[]
