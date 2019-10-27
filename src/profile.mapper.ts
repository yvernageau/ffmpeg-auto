import {ffprobe} from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import {LoggerFactory} from './logger'
import {Chapter, CodecType, InputMedia, InputStream, OutputMedia, Path} from './media'
import {InputConfig, Mapping, MappingOption, OutputConfig, Profile, Task} from './profile'
import {DefaultSnippetResolver, parsePredicate, Snippet, SnippetContext, SnippetResolver, toArray} from './snippet'
import {WorkerContext} from './worker'

const logger = LoggerFactory.get('mapper');

export class ProfileMapper {

    private readonly profile: Profile;

    constructor(profile: Profile) {
        this.profile = profile;
        logger.info("Using profile '%s'", profile.id)
    }

    async apply(file: string): Promise<WorkerContext> {
        logger.info("Applying profile '%s' on '%s' ...", this.profile.id, file);

        return new InputMediaBuilder(this.profile.input).build(file)
            .then(i => new OutputMediaBuilder(this.profile.output).build(i)
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

    private readonly config: InputConfig;

    constructor(config: InputConfig) {
        this.config = config
    }

    async build(file: string): Promise<InputMedia> {
        return new Promise<InputMedia>((resolve, reject) => {
            if (!fs.existsSync(file)) {
                reject("'%s' no longer exists")
            }

            ffprobe(file, ['-show_chapters'], (err, metadata) => {
                if (err) return reject(err.message);

                const input = new InputMedia(
                    0,
                    Path.fromFile(this.config.directory, file),
                    toArray(this.config.params),
                    metadata
                );

                resolveInputParameters(input, {input: input});

                resolve(input)
            })
        })
    }
}

// endregion

// region Output

class OutputMediaBuilder {

    private readonly config: OutputConfig;

    constructor(config: OutputConfig) {
        this.config = config
    }

    async build(media: InputMedia): Promise<OutputMedia[]> {
        return new Promise<OutputMedia[]>((resolve, reject) => {
            let outputId = 0;
            const outputs: OutputMedia[] = this.config.mappings
                .map(m => createBuilder(this.config, m))
                .map(b => {
                    logger.info('> %s ...', b.mapping.id);

                    let output = b.build({input: media}, outputId);
                    outputId += output.length;
                    return output
                })
                .reduce((a, b) => a.concat(...b), []);

            if (outputs.length === 0) return reject('No output: skip');

            // TODO Simplify params (don't '-map' everything)
            outputs.forEach(o => o.streams.forEach(os => os.params.unshift('-map {iid}')));

            // Resolve parameters
            outputs.forEach(o => resolveOutputParameters(o, {input: media, output: o}));

            resolve(outputs)
        })
    }
}

function createBuilder(config: OutputConfig, mapping: Mapping): MappingBuilder {
    if (!mapping.on || mapping.on === 'none') { // [default|none]
        return new SingleMappingBuilder(config, mapping)
    } else if (mapping.on && mapping.on === 'chapters') { // chapters
        return new ChapterMappingBuilder(config, mapping)
    } else { // [all|video|audio|subtitle|attachment]+
        return new ManyMappingBuilder(config, mapping)
    }
}

abstract class MappingBuilder {

    readonly mapping: Mapping;

    protected readonly config: OutputConfig;

    protected constructor(config: OutputConfig, mapping: Mapping) {
        this.config = config;
        this.mapping = mapping
    }

    public static isDisabled(params: Snippet[], stream: InputStream): boolean {
        if (!params) {
            return false
        }

        return disabledCodecsByOption
            .filter(co => params.includes(`-${co.key}`))
            .some(co => co.value === stream.codec_type)
    }

    protected static match(context: SnippetContext, task: Task, stream: InputStream) {
        return (task.on === 'all' || task.on === stream.codec_type || Array.isArray(task.on) && task.on.includes(stream.codec_type))
            && parsePredicate(task.when)({...context, stream: stream})
    }

    abstract build(context: SnippetContext, outputId: number): OutputMedia[]

    protected getGlobalParameters(context: SnippetContext, mapping: Mapping = this.mapping): Snippet[] {
        const parameters: Snippet[] = [];

        if (mapping.params) {
            parameters.push(...toArray(mapping.params))
        }

        if (mapping.options) {
            const options: MappingOption[] = mapping.options
                .filter(o => !o.on || o.on === 'none')
                .filter(o => parsePredicate(o.when)(context));

            parameters.push(...options.map(o => toArray(o.params)).reduce((a, b) => a.concat(...b), []))
        }

        return [...parameters]
    }

    protected getOptions(context: SnippetContext, stream: InputStream, mapping: Mapping = this.mapping): MappingOption[] {
        return mapping.options ? mapping.options.filter(o => MappingBuilder.match(context, o, stream)) : []
    }

    protected getInputStreams(context: SnippetContext, parameters: Snippet[] = this.getGlobalParameters(context)): InputStream[] {
        let streams: InputStream[] = context.input.streams.filter(s => !MappingBuilder.isDisabled(parameters, s));

        if (streams.length > 1 && this.mapping.order) {
            const order: CodecType[] = this.mapping.order;

            streams = streams.sort((s1, s2) => {
                const t1 = s1.codec_type;
                const t2 = s2.codec_type;

                // same type
                if (t1 === t2) return 0;

                // order unspecified for both types (first == second)
                if (order.indexOf(t1) < 0 && order.indexOf(t2) < 0) return 0;

                // order unspecified only for the 1st type: the stream should be placed after
                if (order.indexOf(t1) < 0) return 1;

                // order unspecified only for the 2nd type: the stream should be placed before
                if (order.indexOf(t2) < 0) return -1;

                // order specified for both types
                return order.indexOf(t1) - order.indexOf(t2)
            })
        }

        return streams
    }

    protected resolvePath(context: SnippetContext): Path {
        return Path.fromSnippet(this.mapping.output, context, this.resolvePathExtension(context))
    }

    private resolvePathExtension(context: SnippetContext): string {
        let extension;

        if (this.mapping.format) {
            extension = this.mapping.format
        } else if (context.output.streams.length === 1 && context.stream) {
            const codecName = context.stream.codec_name;
            const extensions = extensionsByCodecName.filter(ec => codecName.match(ec.key));

            if (extensions.length > 0) {
                if (extensions.length === 1) {
                    extension = extensions[0].value
                } else {
                    extension = extensions[0].value;
                    logger.warn(">> Several occurences match the codec '%s': [%s], using '%s'", codecName, extensions.map(ec => `${ec.key}=${ec.value}`), extension)
                }
            } else {
                extension = codecName;
                logger.debug(">> Unable to find the extension for codec '%s'", codecName)
            }
        } else {
            extension = this.config.defaultExtension
        }

        return extension
    }
}

class SingleMappingBuilder extends MappingBuilder {

    constructor(config: OutputConfig, mapping: Mapping) {
        super(config, mapping)
    }

    build(context: SnippetContext, outputId: number): OutputMedia[] {
        if (this.mapping.when && !parsePredicate(this.mapping.when)(context)) {
            logger.info(">> 'when' directive does not match the current context");
            return []
        }

        const output = new OutputMedia(outputId, context.input);
        const outputContext = {...context, output: output};

        const globalParameters = this.getGlobalParameters(outputContext);
        const inputStreams = this.getInputStreams(outputContext, globalParameters);

        let streamId = 0;
        inputStreams
            .forEach(s => {
                const options: MappingOption[] = this.getOptions(outputContext, s);

                // Skip if stream is excluded
                if (options.some(o => o.exclude)) {
                    return
                }

                // Append duplicated streams
                options.filter(o => o.duplicate)
                    .map(o => {
                        return {
                            index: streamId++,
                            source: s,
                            params: [...toArray(o.params)]
                        }
                    })
                    .forEach(os => {
                        output.streams.push(os)
                    });

                // Append current stream
                const streamParameters: string[] = options.filter(o => !o.duplicate)
                    .map(o => toArray(o.params))
                    .reduce((a, b) => a.concat(...b), []);

                output.streams.push({
                    index: streamId++,
                    source: s,
                    params: [...streamParameters]
                })
            });

        if (output.streams.length === 0) {
            return [] // Ignore this output if it does not contain any stream
        }

        output.params = globalParameters;
        output.path = this.resolvePath(outputContext);

        return [output]
    }
}

class ManyMappingBuilder extends MappingBuilder {

    constructor(config: OutputConfig, mapping: Mapping) {
        super(config, mapping)
    }

    build(context: SnippetContext, outputId: number): OutputMedia[] {
        if (this.mapping.options) {
            logger.warn(">> 'options' are disabled when `on != 'none'`")
        }

        const globalParameters = this.getGlobalParameters(context);
        const inputStreams = this.getInputStreams(context, globalParameters);

        return inputStreams
            .map(s => {
                const output = new OutputMedia(outputId++, context.input);
                const outputContext = {...context, output: output, stream: s};

                output.streams.push({
                    index: 0,
                    source: s,
                    params: [...globalParameters]
                });

                output.path = this.resolvePath(outputContext);

                return output
            })
    }

    protected getInputStreams(context: SnippetContext, parameters: Snippet[] = this.getGlobalParameters(context), task: Task = this.mapping): InputStream[] {
        return super.getInputStreams(context, parameters).filter(s => MappingBuilder.match(context, task, s))
    }
}

class ChapterMappingBuilder extends MappingBuilder {

    constructor(config: OutputConfig, mapping: Mapping) {
        super(config, mapping)
    }

    build(context: SnippetContext, outputId: number): OutputMedia[] {
        const chapters = this.getChapters(context);

        return chapters
            .map(chapter => {
                const chapterContext = {...context, chapter: chapter};

                let outputs = new SingleMappingBuilder(this.config, this.mapping)
                    .build(chapterContext, outputId)
                    .map(o => resolveOutputParameters(o, chapterContext));

                outputId += outputs.length;
                return outputs
            })
            .reduce((a, b) => a.concat(...b), [])
    }

    private getChapters(context: SnippetContext): Chapter[] {
        const chapters: Chapter[] = [...context.input.chapters];

        if (!chapters || chapters.length === 0) {
            logger.warn(">> No chapter");
            return []
        }

        const duration = context.input.format.duration;
        const lastChapter = chapters[chapters.length - 1];

        // Add a dummy chapter from the end of the last chapter to the end of the source (if necessary)
        if (lastChapter.end_time !== duration) {
            chapters.push(this.createChapter(lastChapter, duration))
        }

        // Assign chapters number (from 1 to n)
        let chapterId = 1;
        chapters.forEach(c => c.number = chapterId++);

        return chapters
    }

    private createChapter(previousChapter: Chapter, duration: number): Chapter {
        const timeBaseFraction = (<string>previousChapter.time_base).split('/').map(i => parseInt(i));
        const timeBase = timeBaseFraction[0] / timeBaseFraction[1];

        const end = duration / timeBase;

        logger.debug("Add a chapter from '%s' to '%s'", previousChapter.end, end);

        return {
            id: 0,
            time_base: previousChapter.time_base,
            start: previousChapter.end,
            start_time: previousChapter.end_time,
            end: end,
            end_time: duration
        }
    }
}

// endregion

// region Helper functions

// TODO Remove `toString()`
function resolveInputParameters(i: InputMedia, context: SnippetContext): InputMedia {
    const resolver: SnippetResolver = new DefaultSnippetResolver();

    // Resolve general parameters
    i.params = i.params.map(p => resolver.resolve(p, context).toString());

    return i
}

// TODO Remove `toString()`
function resolveOutputParameters(o: OutputMedia, context: SnippetContext): OutputMedia {
    const resolver: SnippetResolver = new DefaultSnippetResolver();

    // Resolve general parameters
    o.params = o.params.map(p => resolver.resolve(p, {
        ...context,
        output: o
    }).toString());

    // Resolve stream-dependent parameters
    o.streams.forEach(os => os.params = os.params.map(p => resolver.resolve(p, {
        ...context,
        output: o,
        stream: os.source,
        outputStream: os
    }).toString()));

    return o
}

// endregion

// region Constants

type KeyValue<K, V> = {
    key: K,
    value: V
}

const extensionsByCodecName: KeyValue<RegExp, string>[] = [
    {key: /subrip/, value: 'srt'}
];

const disabledCodecsByOption: KeyValue<string, CodecType>[] = [
    {key: 'vn', value: 'video'},
    {key: 'an', value: 'audio'},
    {key: 'sn', value: 'subtitle'},
    {key: 'dn', value: 'data'}
];

// endregion