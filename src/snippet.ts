import {LoggerFactory} from './logger'
import {Chapter, InputMedia, InputStream, OutputMedia, OutputStream} from './media'
import {Profile} from './profile'

const logger = LoggerFactory.createDefault('snippet')

export type Snippet = string
export type Snippets = Snippet | Snippet[]

const REGEX: RegExp = /{((?:(?![{}]).)*)}/gi
const REGEX_EXECUTABLE: RegExp = /{{((?:(?!{{).)*)}}/gi

export class SnippetContext {
    profile: Profile
    input: InputMedia
    output?: OutputMedia
    stream?: InputStream
    outputStream?: OutputStream
    chapter?: Chapter // Only when 'mapping.on == chapters'
}

export interface SnippetResolver {
    resolve(snippets: Snippets, context: SnippetContext): string
}

export class DefaultSnippetResolver implements SnippetResolver {

    private readonly resolvers: SnippetResolver[] = [
        new BooleanSnippetResolver(),
        new NumberSnippetResolver(),
        new ShortcutSnippetResolver(),
        new FunctionSnippetResolver()
    ]

    static checkComplete(result: string): string {
        const unformatted = result.match(REGEX)
        if (unformatted) {
            throw new Error('Unknown pattern(s): ' + unformatted.join('; '))
        }
        return result
    }

    resolve(snippets: Snippets, context: SnippetContext): string {
        const snippet: string = (snippets ? Array.isArray(snippets) ? snippets : [snippets] : []).join(' ')
        const result = this.resolvers.reduce((result, resolver) => resolver.resolve(result, context), snippet)

        logger.debug("Resolved: '%s' => '%s'", snippet, result)

        return DefaultSnippetResolver.checkComplete(result)
    }
}

class BooleanSnippetResolver implements SnippetResolver {

    resolve(snippet: string, context: SnippetContext): string {
        return snippet.replace(/{(true|false)}/gi, '$1')
    }
}

class NumberSnippetResolver implements SnippetResolver {

    resolve(snippet: string, context: SnippetContext): string {
        return snippet.replace(/{(\d+(?:.\d+)?)}/gi, '$1')
    }
}

class FunctionSnippetResolver implements SnippetResolver {

    resolve(snippet: string, context: SnippetContext): string {
        // Resolve functions
        return snippet.replace(REGEX_EXECUTABLE, (match, body: string) => parseFunction<string>(body.trim())(context))
    }
}

class ShortcutSnippetResolver implements SnippetResolver {

    static resolveShortcut(snippet: string, context: SnippetContext, shortcut: SnippetShortcut) {
        // noinspection RegExpRedundantEscape
        const regexp = new RegExp(`{([\\._-])?${shortcut.snippet}([\\._-])?}`, 'gi')

        let result: string = snippet

        if (!!result.match(regexp)) {
            let replacement = shortcut.replacement

            if (!!replacement.match(REGEX_EXECUTABLE)) {
                replacement = new FunctionSnippetResolver().resolve(replacement, context)
            }

            result = result.replace(regexp, replacement ? `$1${replacement}$2` : '')
        }

        return result
    }

    resolve(snippet: string, context: SnippetContext): string {
        // Resolve variables & shortcuts
        return shortcuts.reduce((result, s) => ShortcutSnippetResolver.resolveShortcut(result, context, s), snippet)
    }
}

type SnippetFunction<T> = (context: SnippetContext) => T

function parseFunction<T>(body: string): SnippetFunction<T> {
    return (context: SnippetContext) => {
        // Add the 'return' declaration if missing (in case of simple function)
        if (!body.match(/return/)) {
            body = `return ${body}`
        }

        let result: T
        try {
            const parameters: string[] = Object.keys(context)
            const values: any[] = parameters.map(a => (<any>context)[a])
            result = new Function(...parameters, body)(...values)
        }
        catch (e) {
            throw new Error(`Failed to resolve { ${body} } : ${e.message}`)
        }

        if (result === undefined || result === null) {
            throw new Error(`Failed to resolve { ${body} } : returns ${result}`)
        }

        return result
    }
}

export type SnippetPredicate = SnippetFunction<boolean>

export function parsePredicate(exec: Snippets): SnippetPredicate {
    let result: SnippetPredicate = () => true

    if (exec) {
        let parse = (f: string) => parseFunction<boolean>(f)
        let and = (a: SnippetPredicate, b: SnippetPredicate) => (c: SnippetContext) => a(c) && b(c)

        result = Array.isArray(exec)
            ? exec.filter(body => body).map(body => parse(body)).reduce((a, b) => and(a, b), () => true)
            : parse(exec)
    }

    return result
}

type SnippetShortcut = {
    snippet: string
    replacement: string | Snippet
}

const shortcuts: SnippetShortcut[] = [
    {
        snippet: 'iid', // Input stream identifier
        replacement: '{{input.id}}:{{stream.index}}'
    },
    {
        snippet: 'oid', // Output stream identifier
        replacement: '{{outputStream.index}}'
    },
    {
        snippet: 'fn', // Input filename without extension
        replacement: '{{input.path.filename}}'
    },
    {
        snippet: 'lng', // Input stream language | 'und'
        replacement:
            "{{" +
            "stream.tags && stream.tags.language " +
            "? stream.tags.language " +
            ": 'und' " +
            "}}"
    },
    {
        snippet: 'label', // 'forced' | 'sdh'
        replacement:
            "{{" +
            "(stream.disposition && stream.disposition.forced === 1) || (stream.tags && stream.tags.title && !!stream.tags.title.match(/forced/i)) " +
            "? 'forced' " +
            ": (stream.disposition && stream.disposition.hearing_impaired === 1) || (stream.tags && stream.tags.title && !!stream.tags.title.match(/hi|sdh/i)) " +
            "? 'sdh' " +
            ": '' " +
            "}}"
    },
]