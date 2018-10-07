import * as path from 'path'
import {Chapter, OutputMedia} from './media'
import {Mapping, Option} from './profile'
import {DefaultSnippetResolver, newPredicate, SnippetContext, SnippetResolver} from './snippet'

function resolveParameters(o: OutputMedia, context: SnippetContext): OutputMedia {
    const resolver: SnippetResolver = new DefaultSnippetResolver()

    o.params = o.params.map(p => resolver.resolve(p, {
        ...context,
        output: o
    }))

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

function getExtension(codecName: string): string {
    switch (codecName) {
        case 'subrip':
            return 'srt'
        default:
            return codecName
    }
}

export class MediaBuilder {

    private static createBuilder(mapping: Mapping) {
        // [default|none]
        if (!mapping.on || mapping.on === 'none') {
            return new DefaultMappingBuilder(mapping)
        }
        // chapters
        else if (mapping.on && mapping.on === 'chapters') {
            return new ChapterMappingBuilder(mapping)
        }
        // [all|video|audio|subtitle]
        else {
            return new ManyMappingBuilder(mapping)
        }
    }

    build(context: SnippetContext): OutputMedia[] {
        if (!context.profile.output.mappings) {
            throw new Error('No task defined')
        }

        if (context.profile.output.mappings.filter(tm => !tm.skip).some(tm => !tm.output)) {
            throw new Error("An output must be defined for each 'mappings'")
        }

        let outputsCount = 0
        return context.profile.output.mappings
            .filter(m => !m.skip)
            .map(m => MediaBuilder.createBuilder(m))
            .map(b => {
                let output = b.build(context, outputsCount)
                outputsCount += output.length
                return output
            })
            .reduce((a, b) => a.concat(...b), [])
            .map(o => resolveParameters(o, context))
    }
}

abstract class MappingBuilder {
    protected readonly mapping: Mapping

    protected constructor(mapping: Mapping) {
        this.mapping = mapping
    }

    abstract build(context: SnippetContext, outputsCount: number): OutputMedia[]
}

class DefaultMappingBuilder extends MappingBuilder {

    constructor(mapping: Mapping) {
        super(mapping)
    }

    build(context: SnippetContext, outputsCount: number): OutputMedia[] {
        if (this.mapping.when && !newPredicate(this.mapping.when)(context)) {
            console.log("[compose:%s] 'when' directive does not match the current context", this.mapping.id)
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
                .filter(o => newPredicate(o.when)(localContext))
                .map(o => Array.isArray(o.params) ? o.params : [o.params])
                .reduce((a, b) => a.concat(...b)))

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
                .filter(o => newPredicate(o.when)({...localContext, stream: s}))

            if (localOptions && localOptions.length > 0) {
                localOptions.forEach(o => {
                    let optionParams: string[] = Array.isArray(o.params) ? o.params : [o.params]
                    if (optionParams.some(p => p.search(/-map/) >= 0)) {
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
            parent: path.resolve(context.profile.output.directory, path.relative(context.profile.input.directory, context.input.path.parent)),
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
        let chaptersCount = 1
        let chapters: Chapter[] = context.input.chapters

        if (!chapters) {
            console.warn("[compose:%s] No chapter", this.mapping.id)
            return []
        }

        let duration = context.input.format.duration
        let lastChapter = chapters[chapters.length - 1]

        // Add a dummy chapter from the end of the last chapter to the end of the source
        if (lastChapter.end_time !== duration) {
            chapters.push({
                id: 0,
                time_base: lastChapter.time_base,
                start: lastChapter.end,
                start_time: lastChapter.end_time,
                end: context.input.format.duration * 1e6, // TODO Calculate the factor
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
                let output: OutputMedia[] = new DefaultMappingBuilder(this.mapping).build(localContext, outputsCount)
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
        if (this.mapping.options) {
            console.warn("[compose:%s] 'options' are disabled when `on != 'none'`", this.mapping.id)
        }

        const resolver: SnippetResolver = new DefaultSnippetResolver()

        return context.input.streams
            .filter(s => this.mapping.on === s.codec_type || this.mapping.on === 'all')
            .filter(s => newPredicate(this.mapping.when)({...context, stream: s}))
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
                    parent: path.resolve(context.profile.output.directory, path.relative(context.profile.input.directory, context.input.path.parent)),
                    filename: resolver.resolve(this.mapping.output, {...context, output: output, stream: s}),
                    extension: this.mapping.format ? this.mapping.format : getExtension(s.codec_name),
                }

                return output
            })
    }
}
