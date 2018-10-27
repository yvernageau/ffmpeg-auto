import {ffprobe} from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import * as path from 'path'
import {LoggerFactory} from './logger'
import {Chapter, InputMedia, InputStream, OutputMedia, OutputStream, Path} from './media'
import {Mapping, Option, Profile} from './profile'
import {DefaultSnippetResolver, parsePredicate, Snippet, SnippetContext, SnippetResolver, toArray} from './snippet'
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

        return new InputMediaBuilder(this.profile)
            .build(inputFile)
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

// region Input

class InputMediaBuilder {

    private readonly profile: Profile

    constructor(profile: Profile) {
        this.profile = profile
    }

    async build(file: string): Promise<InputMedia> {
        return new Promise<InputMedia>((resolve, reject) => {
            if (!fs.existsSync(file)) {
                reject("'%s' no longer exists")
            }

            ffprobe(file, ['-show_chapters'], (err, metadata) => {
                if (err) return reject(err.message)

                const params: Snippet[] = this.profile.input ? toArray(this.profile.input.params) : []
                const path: Path = this.resolvePath(file)

                const input = new InputMedia(0, path, params, metadata)

                resolveInputParameters(input, {profile: this.profile, input: input})

                resolve(input)
            })
        })
    }

    private resolvePath(file: string) {
        const filepath = path.parse(file)

        return {
            parent: path.relative(this.profile.input.directory, filepath.dir),
            filename: filepath.name,
            extension: filepath.ext.replace(/^\./, '') // Remove the heading dot
        }
    }
}

// endregion

// region Output

class OutputMediaBuilder {

    async build(profile: Profile, input: InputMedia): Promise<OutputMedia[]> {
        return new Promise<OutputMedia[]>((resolve, reject) => {
            let outputsCount = 0
            const outputs: OutputMedia[] = profile.output.mappings
                .map(m => createBuilder(m))
                .map(b => {
                    let output = b.build({profile: profile, input: input}, outputsCount)
                    outputsCount += output.length
                    return output
                })
                .reduce((a, b) => a.concat(...b), [])
                .map(o => resolveOutputParameters(o, {profile: profile, input: input, output: o}))

            if (outputs.length === 0) {
                return reject('No output: skip')
            }

            // TODO Simplify params

            resolve(outputs)
        })
    }
}

function createBuilder(mapping: Mapping): MappingBuilder {
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

    abstract build(context: SnippetContext, currentId: number): OutputMedia[]
}

class SingleMappingBuilder extends MappingBuilder {

    constructor(mapping: Mapping) {
        super(mapping)
    }

    build(context: SnippetContext, currentId: number): OutputMedia[] {
        logger.info('> %s:%s ...', context.profile.id, this.mapping.id)

        if (this.mapping.when && !parsePredicate(this.mapping.when)(context)) {
            logger.info(">> 'when' directive does not match the current context")
            return []
        }

        const output = new OutputMedia(currentId, context.input)
        const outputContext = {...context, output: output}

        output.params = this.getGlobalParameters(outputContext)

        const streams: OutputStream[] = this.createStreams(context)

        if (streams.length === 0) {
            return [] // Ignore this output if it does not contain any stream
        }

        output.streams = streams
        output.path = this.resolvePath(outputContext)

        return [output]
    }

    private createStreams(context: SnippetContext): OutputStream[] {
        const tasks = this.getTasks()

        let streamsCount = 0
        return context.input.streams
            .map(s => {
                let streams = new OutputStreamBuilder().build(context, s, tasks, streamsCount)
                streamsCount += streams.length
                return streams
            })
            .reduce((a, b) => a.concat(...b), [])
    }

    private getGlobalParameters(context: SnippetContext): string[] {
        const parameters: string[] = []

        if (this.mapping.params) {
            parameters.push(...toArray(this.mapping.params))
        }

        if (this.mapping.options && this.mapping.options.length > 0) {
            parameters.push(...this.mapping.options
                .filter(o => !o.on || o.on === 'none')
                .filter(o => parsePredicate(o.when)(context))
                .map(o => toArray(o.params))
                .reduce((a, b) => a.concat(...b), [])
            )
        }

        return parameters
    }

    private getTasks(): Option[] {
        const tasks: Option[] = []
        if (this.mapping.options && this.mapping.options.length > 0) {
            tasks.push(...this.mapping.options.filter(o => o.on && o.on !== 'none'))
        }
        return tasks
    }

    private resolvePath(context: SnippetContext): Path {
        return {
            parent: context.input.path.parent,
            filename: new DefaultSnippetResolver().resolve(this.mapping.output, context),
            extension: this.mapping.format ? this.mapping.format : context.profile.output.defaultExtension
        }
    }
}

class OutputStreamBuilder {

    build(context: SnippetContext, stream: InputStream, tasks: Option[], currentId: number): OutputStream[] {
        const streams: OutputStream[] = []
        const streamParams: string[] = []

        // Retrieve options related to this stream
        const relOptions: Option[] = tasks
            .filter(o => o.on === 'all' || o.on === stream.codec_type || Array.isArray(o.on) && o.on.includes(stream.codec_type))
            .filter(o => parsePredicate(o.when)({...context, stream: stream}))

        if (relOptions.some(o => o.exclude)) {
            return streams
        }

        if (relOptions && relOptions.length > 0) {
            relOptions.forEach(o => {
                let relOptionParams: string[] = toArray(o.params)
                if (relOptionParams.some(p => !!p.match(/-map/))) { // TODO Use a better way to duplicate a stream
                    streams.push({
                        index: currentId++,
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
            index: currentId++,
            source: stream,
            params: ['-map {iid}', ...streamParams]
        })

        return streams
    }
}

class ChapterMappingBuilder extends MappingBuilder {

    constructor(mapping: Mapping) {
        super(mapping)
    }

    build(context: SnippetContext, currentId: number): OutputMedia[] {
        logger.info('> %s:%s ...', context.profile.id, this.mapping.id)

        let chaptersCount: number = 1
        const chapters = this.getChapters(context)

        logger.info(JSON.stringify(chapters))

        return chapters
            .map(ch => {
                return {...context, chapter: {...ch, number: chaptersCount++}}
            })
            .map(localContext => {
                let output: OutputMedia[] = new SingleMappingBuilder(this.mapping).build(localContext, currentId)
                currentId += output.length

                // Resolve parameters with the current chapter information
                output.forEach(o => resolveOutputParameters(o, localContext))

                return output
            })
            .reduce((a, b) => a.concat(...b), [])
    }

    private getChapters(context: SnippetContext): Chapter[] {
        const chapters: Chapter[] = [...context.input.chapters]

        if (!chapters || chapters.length === 0) {
            logger.warn(">> No chapter")
            return []
        }

        const duration = context.input.format.duration
        const lastChapter = chapters[chapters.length - 1]

        // Add a dummy chapter from the end of the last chapter to the end of the source (if necessary)
        if (lastChapter.end_time !== duration) {
            const timeBaseFractionParts = (<string>lastChapter.time_base).split('/').map(i => parseInt(i))
            const timeBaseFraction = timeBaseFractionParts[0] / timeBaseFractionParts[1]

            const end = duration / timeBaseFraction

            logger.debug("Add a chapter from '%s' to '%s'", lastChapter.end, end)

            chapters.push({
                id: 0,
                time_base: lastChapter.time_base,
                start: lastChapter.end,
                start_time: lastChapter.end_time,
                end: end,
                end_time: duration
            })
        }

        return chapters
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
                let output = this.buildOutput(context, s, outputsCount)
                outputsCount += output ? 1 : 0
                return output
            })
            .filter(o => o)
    }

    private buildOutput(context: SnippetContext, stream: InputStream, currentId: number): OutputMedia {
        const output = new OutputMedia(currentId, context.input)

        output.streams.push({
            index: 0,
            source: stream,
            params: ['-map {iid}', ...toArray(this.mapping.params)]
        })

        output.path = this.resolvePath({...context, output: output, stream: stream})

        return output
    }

    private resolvePath(context: SnippetContext): Path {
        return {
            parent: context.input.path.parent,
            filename: new DefaultSnippetResolver().resolve(this.mapping.output, context),
            extension: this.mapping.format ? this.mapping.format : resolveExtension(context.stream.codec_name),
        }
    }
}

// endregion

// region Helper functions

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

// endregion