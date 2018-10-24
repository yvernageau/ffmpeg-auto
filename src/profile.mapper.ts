import {ffprobe} from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import * as path from "path"
import {LoggerFactory} from './logger'
import {Chapter, InputMedia, OutputMedia} from './media'
import {Mapping, Option, Profile} from './profile'
import {DefaultSnippetResolver, parsePredicate, SnippetContext, SnippetResolver} from './snippet'
import {WorkerContext} from './worker'

const logger = LoggerFactory.get('builder')

export class ProfileMapper {

    private readonly profile: Profile

    constructor(profile: Profile) {
        this.profile = profile
    }

    async apply(inputFile: string): Promise<WorkerContext> {
        return new Promise<WorkerContext>((resolve, reject) => {
            new InputMediaBuilder().build(this.profile, inputFile)
                .then(input => {
                    resolve({
                        profile: this.profile,
                        input: input,
                        outputs: new OutputMediaBuilder().build(this.profile, input)
                    })
                })
                .catch(reason => reject(reason))
        })
    }
}

class InputMediaBuilder {

    async build(profile: Profile, inputFile: string) {
        return fs.stat(inputFile) // Ensure the file still exists
            .then(() => new Promise<InputMedia>((resolve, reject) => {
                ffprobe(inputFile, (err, data) => {
                    if (err) {
                        return reject(err.message)
                    }

                    const filepath = path.parse(inputFile)

                    resolve(new InputMedia(0, {
                        parent: path.relative(profile.input.directory, filepath.dir),
                        filename: filepath.name,
                        extension: filepath.ext.replace(/^\./, '')
                    }, data))
                })
            }))
    }
}

class OutputMediaBuilder {

    // TODO Make it async
    build(profile: Profile, input: InputMedia): OutputMedia[] {
        if (!profile.output.mappings) {
            throw new Error('No task defined')
        }

        if (profile.output.mappings.filter(tm => !tm.skip).some(tm => !tm.output)) {
            throw new Error("An output must be defined for each 'mappings'")
        }

        let outputsCount = 0
        return profile.output.mappings
            .filter(m => !m.skip)
            .map(m => getMappingBuilder(m))
            .map(b => {
                let output = b.build({profile: profile, input: input}, outputsCount)
                outputsCount += output.length
                return output
            })
            .reduce((a, b) => a.concat(...b), [])
            .map(o => resolveParameters(o, {profile: profile, input: input}))
    }
}

function getMappingBuilder(mapping: Mapping) {
    if (!mapping.on || mapping.on === 'none') { // [default|none]
        return new SingleMappingBuilder(mapping)
    }
    else if (mapping.on && mapping.on === 'chapters') { // chapters
        return new ChapterMappingBuilder(mapping)
    }
    else { // [all|video|audio|subtitle]+
        return new ManyMappingBuilder(mapping)
    }
}

abstract class MappingBuilder {

    protected readonly mapping: Mapping

    protected constructor(mapping: Mapping) {
        this.mapping = mapping
    }

    abstract build(context: SnippetContext, outputsCount: number): OutputMedia[]
}

class SingleMappingBuilder extends MappingBuilder {

    constructor(mapping: Mapping) {
        super(mapping)
    }

    build(context: SnippetContext, outputsCount: number): OutputMedia[] {
        logger.info('Building [%s] ...', this.mapping.id)

        if (this.mapping.when && !parsePredicate(this.mapping.when)(context)) {
            logger.warn("> 'when' directive does not match the current context")
            return []
        }

        let resolver: SnippetResolver = new DefaultSnippetResolver()

        const output = new OutputMedia(outputsCount, context.input)
        const localContext = {...context, output: output}

        let options: Option[] = []

        // Resolve parameters
        if (this.mapping.params) {
            output.params.push(...this.mapping.params)
        }

        if (this.mapping.options && this.mapping.options.length > 0) {
            output.params.push(...this.mapping.options
                .filter(o => !o.skip)
                .filter(o => !o.on || o.on === 'none')
                .filter(o => parsePredicate(o.when)(localContext))
                .map(o => Array.isArray(o.params) ? o.params : [o.params])
                .reduce((a, b) => a.concat(...b), []))

            options.push(...this.mapping.options
                .filter(o => !o.skip)
                .filter(o => o.on && o.on !== 'none'))
        }

        // Resolve streams
        let streamsCount = 0
        context.input.streams.forEach(s => {
            let params: string[] = []

            let localOptions: Option[] = options
                .filter(o => o.on === s.codec_type || o.on === 'all')
                .filter(o => parsePredicate(o.when)({...localContext, stream: s}))

            if (localOptions && localOptions.length > 0) {
                localOptions.forEach(o => {
                    let optionParams: string[] = Array.isArray(o.params) ? o.params : [o.params]
                    if (optionParams.some(p => !!p.match(/-map/))) {
                        output.streams.push({
                            index: streamsCount++,
                            source: s,
                            params: optionParams
                        })
                    }
                    else {
                        params.push(...optionParams)
                    }
                })

                output.streams.push({
                    index: streamsCount++,
                    source: s,
                    params: ['-map {iid}', ...params]
                })
            }
        })

        // Resolve path
        output.path = {
            parent: context.input.path.parent,
            filename: resolver.resolve(this.mapping.output, localContext),
            extension: this.mapping.format ? this.mapping.format : context.profile.output.defaultExtension
        }

        // Ignore this output if it does not contain any stream
        return streamsCount > 0 ? [output] : []
    }
}

class ChapterMappingBuilder extends MappingBuilder {

    constructor(mapping: Mapping) {
        super(mapping)
    }

    build(context: SnippetContext, outputsCount: number): OutputMedia[] {
        logger.info('Building [%s] ...', this.mapping.id)

        let chaptersCount = 1
        let chapters: Chapter[] = context.input.chapters

        if (!chapters || chapters.length === 0) {
            logger.warn("> No chapter")
            return []
        }

        let duration = context.input.format.duration
        let lastChapter = chapters[chapters.length - 1]

        // Add a dummy chapter from the end of the last chapter to the end of the source
        if (lastChapter.end_time !== duration) {
            const timeBaseFractionParts = (<string>lastChapter.time_base).split('/').map(i => parseInt(i))
            let timeBaseFraction = timeBaseFractionParts[0] / timeBaseFractionParts[1]

            chapters.push({
                id: 0,
                time_base: lastChapter.time_base,
                start: lastChapter.end,
                start_time: lastChapter.end_time,
                end: context.input.format.duration / timeBaseFraction,
                end_time: duration
            })
        }

        // FIXME The (existing) last chapter is not added to the 'default' mapping
        return chapters
            .map(ch => {
                return {
                    ...context,
                    chapter: {...ch, number: chaptersCount++}
                }
            })
            .map(localContext => {
                let output: OutputMedia[] = new SingleMappingBuilder(this.mapping).build(localContext, outputsCount)
                outputsCount += output.length

                output.forEach(o => resolveParameters(o, localContext))

                return output
            })
            .reduce((a, b) => a.concat(...b), [])
    }
}

class ManyMappingBuilder extends MappingBuilder {

    constructor(mapping: Mapping) {
        super(mapping)
    }

    build(context: SnippetContext, outputsCount: number): OutputMedia[] {
        logger.info('Building [%s] ...', this.mapping.id)

        if (this.mapping.options) {
            logger.warn("> 'options' are disabled when `on != 'none'`")
        }

        const resolver: SnippetResolver = new DefaultSnippetResolver()

        return context.input.streams
            .filter(s => this.mapping.on === s.codec_type || this.mapping.on === 'all')
            .filter(s => parsePredicate(this.mapping.when)({...context, stream: s}))
            .map(s => {
                const output = new OutputMedia(outputsCount++, context.input)

                // Resolve streams
                output.streams.push({
                    index: 0,
                    source: s,
                    params: ['-map {iid}', ...Array.isArray(this.mapping.params) ? this.mapping.params : [this.mapping.params]]
                })

                // Resolve path
                output.path = {
                    parent: context.input.path.parent,
                    filename: resolver.resolve(this.mapping.output, {...context, output: output, stream: s}),
                    extension: this.mapping.format ? this.mapping.format : resolveExtension(s.codec_name),
                }

                return output
            })
    }
}

function resolveParameters(o: OutputMedia, context: SnippetContext): OutputMedia {
    const resolver: SnippetResolver = new DefaultSnippetResolver()

    // Resolve general parameters
    o.params = o.params.map(p => resolver.resolve(p, {
        ...context,
        output: o
    }))

    // Resolve stream-dependent parameters
    o.streams.forEach(os => {
        os.params = os.params.map(p => resolver.resolve(p, {
            ...context,
            output: o,
            stream: os.source,
            outputStream: os
        }))
    })

    return o
}

function resolveExtension(codecName: string): string {
    const possibleExtensions: CodecExtension[] = extensionsByCodec.filter(ec => codecName.match(ec.codecName))
    let extension: string

    if (possibleExtensions && possibleExtensions.length > 0) {
        if (possibleExtensions.length === 1) {
            extension = possibleExtensions[0].extension
            logger.verbose("> Using extension '%s' for codec '%'", extension, codecName)
        }
        else {
            extension = possibleExtensions[0].extension
            logger.warn("> Several occurences match the codec '%s': [%s], using '%s'", codecName, possibleExtensions.map(ec => ec.codecName + '=' + ec.extension), extension)
        }
    }
    else {
        extension = codecName
        logger.debug("> Unable to find the extension for codec '%s', using '%s'", codecName, extension)
    }

    return extension
}

type CodecExtension = {
    codecName: RegExp,
    extension: string
}

// TODO Complete this list
const extensionsByCodec: CodecExtension[] = [
    {codecName: /subrip/, extension: 'srt'}
]