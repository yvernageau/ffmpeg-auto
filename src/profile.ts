import * as fs from 'fs-extra'
import {CodecType} from './media'
import {Snippet, Snippets} from './snippet'
import * as jsyaml from 'js-yaml';

export class Profile {
    [key: string]: any

    id: string;
    input: InputConfig;
    output: OutputConfig;

    static load(path: string): Profile {
        return {
            ...new Profile(),
            ...jsyaml.safeLoad(fs.readFileSync(path, 'utf-8')) as Profile
        }
    }
}

export class IOConfig {
    directory: string
}

export class InputConfig extends IOConfig {
    include?: RegExp;
    exclude?: RegExp;
    params?: Snippets;
    deleteAfterProcess?: boolean
}

// TODO Support for filters (filter_complex)
export class OutputConfig extends IOConfig {
    defaultExtension?: string;
    writeLog?: boolean;
    mappings: Mapping[]
}

export abstract class Task {
    id?: string;
    skip?: boolean;
    on?: StreamSelector;
    when?: Snippets;
    params?: Snippets
}

export class Mapping extends Task {
    output: Snippet;
    order?: CodecType[];
    format?: string;
    options?: MappingOption[]
}

export class MappingOption extends Task {
    duplicate: boolean;
    exclude: boolean
}

export type StreamSelector = 'all' | 'none' | 'chapters' | CodecType | CodecType[]
