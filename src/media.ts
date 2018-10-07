import * as path from 'path'
import {ParsedPath} from 'path'
import {Snippet} from './snippet'

export class Path {
    parent: string
    filename: string
    extension: string
}

export class Media {
    readonly id: number = 0
    path: Path

    constructor(id: number, path?: Path) {
        this.id = id
        this.path = path
    }

    resolvePath(): string {
        return path.resolve(this.path.parent, this.path.filename + '.' + this.path.extension)
    }
}

export class InputMedia extends Media {
    readonly streams: InputStream[]
    readonly format: Format
    readonly chapters: Chapter[]

    constructor(id: number, path: ParsedPath, meta: any) {
        super(id, {
            parent: path.dir,
            filename: path.name,
            extension: path.ext.replace(/^\./, '')
        })

        this.streams = meta.streams
        this.format = meta.format
        this.chapters = meta.chapters
    }
}

export class OutputMedia extends Media {
    readonly source: InputMedia

    params: Snippet[]
    streams: OutputStream[]

    constructor(id: number, source: InputMedia, params: Snippet[] = [], streams: OutputStream[] = []) {
        super(id, undefined)
        this.source = source
        this.params = params
        this.streams = streams
    }
}

export class Stream {
    index: number
}

export class InputStream extends Stream {
    readonly [key: string]: any

    readonly disposition?: Dispositions
    readonly tags?: Tags
}

export class OutputStream extends Stream {
    source: InputStream
    params: Snippet[]
}

export type Format = {
    readonly [key: string]: any

    readonly tags?: Tags
}

export type Chapter = {
    readonly [key: string]: any

    readonly tags?: Tags
}

export type Tags = {
    readonly [key: string]: any

    readonly title?: string
    readonly language?: string
}

export type Dispositions = {
    readonly [key: string]: 0 | 1
}
