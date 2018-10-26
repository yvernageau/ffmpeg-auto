import {ffprobe} from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import * as path from 'path'
import {LoggerFactory} from './logger'
import {Chapter, InputMedia, InputStream, OutputMedia, OutputStream, Path} from './media'
import {Mapping, Option, Profile} from './profile'
import {DefaultSnippetResolver, parsePredicate, SnippetContext, SnippetResolver, toArray} from './snippet'
import {WorkerContext} from './worker'

const logger = LoggerFactory.get('mapper')

export class ProfileMapper {

    private readonly profile: Profile

    constructor(profile: Profile) {
        this.profile = profile
        logger.info("Using profile '%s'", profile.id)
    }

    async apply(inputFile: string): Promise<WorkerContext> {
        logger.info("Applying profile '%s' on '%s' ...", this.profile.id, inputFile)

        return new InputMediaBuilder()
            .build(this.profile, inputFile)
            .then(i => new OutputMediaBuilder()
                .build(this.profile, i)
                .then(os => {
                    return {
                        profile: this.profile,
                        input: i,
                        outputs: os
                    }
                }))
    }
}

class InputMediaBuilder {

    async build(profile: Profile, inputFile: string): Promise<InputMedia> {
        return new Promise<InputMedia>((resolve, reject) => {
            if (!fs.existsSync(inputFile)) {
                reject("'%s' no longer exists")
            }

            ffprobe(inputFile, (err, data) => {
                if (err) {
                    return reject(err.message)
                }

                const filepath = path.parse(inputFile)
                const input = new InputMedia(
                    0,
                    {
                        parent: path.relative(profile.input.directory, filepath.dir),
                        filename: filepath.name,
                        extension: filepath.ext.replace(/^\./, '')
                    },
                    profile.input ? toArray(profile.input.params) : [],
                    data
                )

                resolveInputParameters(input, {profile: profile, input: input})

                resolve(input)
            })
        })
    }
}

class OutputMediaBuilder {

    async build(profile: Profile, input: InputMedia): Promise<OutputMedia[]> {
        return new Promise<OutputMedia[]>(resolve => {
            let outputsCount = 0
            const outputs: OutputMedia[] = profile.output.mappings
                .map(m => getMappingBuilder(m))
                .map(b => {
                    let output = b.build({profile: profile, input: input}, outputsCount)
                    outputsCount += output.length
                    return output
                })
                .reduce((a, b) => a.concat(...b), [])
                .map(o => resolveOutputParameters(o, {profile: profile, input: input, output: o}))

            resolve(outputs)
        })
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
        logger.info('> %s:%s ...', context.profile.id, this.mapping.id)

        if (this.mapping.when && !parsePredicate(this.mapping.when)(context)) {
            logger.warn(">> 'when' directive does not match the current context")
            return []
        }

        const output = new OutputMedia(outputsCount, context.input)
        const localContext = {...context, output: output}

        const options = this.buildOptions(localContext, output)

        let streamsCount = 0
        const streams = context.input.streams
            .map(s => {
                let streams = this.buildStream(localContext, s, options, streamsCount)
                streamsCount += streams.length
                return streams
            })
            .reduce((result, ss) => result.concat(ss), [])

        // Ignore this output if it does not contain any stream
        if (streamsCount === 0) {
            return []
        }

        output.streams = streams
        output.path = this.buildPath(localContext)
        return [output]
    }

    buildOptions(context: SnippetContext, output: OutputMedia) {
        const options: Option[] = []

        // Resolve global parameters
        if (this.mapping.params) {
            output.params.push(...this.mapping.params)
        }

        if (this.mapping.options && this.mapping.options.length > 0) {
            // Resolve other global parameters
            output.params.push(...this.mapping.options
                .filter(o => !o.on || o.on === 'none')
                .filter(o => parsePredicate(o.when)(context))
                .map(o => toArray(o.params))
                .reduce((a, b) => a.concat(...b), []))

            // Resolve task parameters
            options.push(...this.mapping.options.filter(o => o.on && o.on !== 'none'))
        }

        return options
    }

    buildStream(context: SnippetContext, stream: InputStream, options: Option[], streamsCount: number): OutputStream[] {
        const streams: OutputStream[] = []
        const streamParams: string[] = []

        const relOptions: Option[] = options
            .filter(o => o.on === 'all' || o.on === stream.codec_type || Array.isArray(o.on) && o.on.includes(stream.codec_type))
            .filter(o => parsePredicate(o.when)({...context, stream: stream}))

        if (relOptions.some(o => o.exclude)) {
            return streams
        }

        if (relOptions && relOptions.length > 0) {
            relOptions.forEach(o => {
                let relOptionParams: string[] = toArray(o.params)
                if (relOptionParams.some(p => !!p.match(/-map/))) {
                    streams.push({
                        index: streamsCount++,
                        source: stream,
                        params: relOptionParams
                    })
                }
                else {
                    streamParams.push(...relOptionParams)
                }
            })
        }
        else {
            // Copy the input stream by default
            streamParams.push('-c:{oid} copy')
        }

        streams.push({
            index: streamsCount++,
            source: stream,
            params: ['-map {iid}', ...streamParams]
        })

        return streams
    }

    buildPath(context: SnippetContext): Path {
        return {
            parent: context.input.path.parent,
            filename: new DefaultSnippetResolver().resolve(this.mapping.output, context),
            extension: this.mapping.format ? this.mapping.format : context.profile.output.defaultExtension
        }
    }
}

class ChapterMappingBuilder extends MappingBuilder {

    constructor(mapping: Mapping) {
        super(mapping)
    }

    build(context: SnippetContext, outputsCount: number): OutputMedia[] {
        logger.info('> %s:%s ...', context.profile.id, this.mapping.id)

        let chaptersCount = 1
        let chapters: Chapter[] = context.input.chapters

        if (!chapters || chapters.length === 0) {
            logger.warn(">> No chapter")
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

                output.forEach(o => resolveOutputParameters(o, localContext))

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
        logger.info('> %s:%s ...', context.profile.id, this.mapping.id)

        if (this.mapping.options) {
            logger.warn(">> 'options' are disabled when `on != 'none'`")
        }

        return context.input.streams
            .filter(s => this.mapping.on === 'all' || this.mapping.on === s.codec_type || Array.isArray(this.mapping.on) && this.mapping.on.includes(s.codec_type))
            .filter(s => parsePredicate(this.mapping.when)({...context, stream: s}))
            .map(s => {
                const output = new OutputMedia(outputsCount++, context.input)

                output.streams.push({
                    index: 0,
                    source: s,
                    params: ['-map {iid}', ...toArray(this.mapping.params)]
                })

                output.path = this.buildPath({...context, output: output, stream: s})

                return output
            })
    }

    buildPath(context: SnippetContext): Path {
        return {
            parent: context.input.path.parent,
            filename: new DefaultSnippetResolver().resolve(this.mapping.output, context),
            extension: this.mapping.format ? this.mapping.format : resolveExtension(context.stream.codec_name),
        }
    }
}

function resolveInputParameters(i: InputMedia, context: SnippetContext): InputMedia {
    const resolver: SnippetResolver = new DefaultSnippetResolver()

    // Resolve general parameters
    i.params = i.params.map(p => resolver.resolve(p, context))

    return i
}

function resolveOutputParameters(o: OutputMedia, context: SnippetContext): OutputMedia {
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
            logger.verbose(">> Using extension '%s' for codec '%s'", extension, codecName)
        }
        else {
            extension = possibleExtensions[0].extension
            logger.warn(">> Several occurences match the codec '%s': [%s], using '%s'", codecName, possibleExtensions.map(ec => ec.codecName + '=' + ec.extension), extension)
        }
    }
    else {
        extension = codecName
        logger.debug(">> Unable to find the extension for codec '%s', using '%s'", codecName, extension)
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