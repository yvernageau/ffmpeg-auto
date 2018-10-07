import * as fs from "fs-extra"
import {Snippet, Snippets} from './snippet'

export class Profile {
    [key: string]: any

    name: string

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
    includes?: RegExp
    excludes?: RegExp

    params?: Snippets = []
}

// TODO Support for filters (filter_complex)
export class OutputConfig extends IOConfig {
    defaultExtension?: string = 'mkv'
    writeLog?: boolean = false

    mappings: Mapping[] = []
}

export class Task {
    id?: string

    on?: StreamSelector = 'none'
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
}

// TODO ComposableStreamSelectors can be grouped in an array
export type ComposableStreamSelector = 'video' | 'audio' | 'subtitle'
export type StreamSelector = 'all' | 'none' | 'chapters' | ComposableStreamSelector
