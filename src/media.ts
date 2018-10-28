import * as path from 'path'
import {Snippet} from './snippet'

export type Path = {
    parent: string
    filename: string
    extension: string
}

export function resolvePath(p: Path, basedir: string) {
    return path.format({
        dir: path.resolve(basedir, p.parent),
        name: p.filename,
        ext: `.${p.extension}`
    })
}

export class Media {
    readonly id: number = 0
    path: Path
    params: Snippet[]

    constructor(id: number, path?: Path) {
        this.id = id
        this.path = path
    }
}

export class InputMedia extends Media {
    readonly streams: InputStream[]
    readonly format: Format
    readonly chapters?: Chapter[]

    constructor(id: number, path: Path, params: Snippet[] = [], meta: any) {
        super(id, path)
        this.params = params
        this.streams = meta.streams
        this.format = meta.format
        this.chapters = meta.chapters
    }
}

export class OutputMedia extends Media {
    readonly source: InputMedia
    streams: OutputStream[]

    constructor(id: number, source: InputMedia, params: Snippet[] = [], streams: OutputStream[] = []) {
        super(id, undefined)
        this.source = source
        this.params = params
        this.streams = streams
    }
}

export type Stream = {
    index: number
}

export type CodecType = 'video' | 'audio' | 'subtitle' | 'data'

export type InputStream = Stream & {
    readonly [key: string]: any

    readonly codec_name: string
    readonly codec_type: CodecType
    readonly disposition?: Dispositions
    readonly tags?: Tags
}

export type OutputStream = Stream & {
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
}

export type Dispositions = {
    readonly [key: string]: NumericBoolean
}

export type NumericBoolean = 0 | 1 // 0 = false | 1 = true