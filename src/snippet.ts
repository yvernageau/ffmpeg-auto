import {LoggerFactory} from './logger'
import {Chapter, InputMedia, InputStream, OutputMedia, OutputStream} from './media'
import {Profile} from './profile'

const logger = LoggerFactory.get('snippet')

export type Snippet = string
export type Snippets = Snippet | Snippet[]

const REGEX: RegExp = /{((?:(?![{}]).)*)}/gi
const REGEX_EXECUTABLE: RegExp = /{=((?:(?!{=|;}).)*);}/gi // TODO Remove tailing ';'

export class SnippetContext {
    profile: Profile
    input: InputMedia
    output?: OutputMedia
    stream?: InputStream
    outputStream?: OutputStream
    chapter?: Chapter // Only when 'mapping.on == chapters'
}

type SnippetFunction<T> = (context: SnippetContext) => T

function parseFunction<T>(body: string): SnippetFunction<T> {
    return (context: SnippetContext) => {
        // Add the 'return' declaration if missing (in case of simple function)
        if (body.search(/return/) < 0) {
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

        logger.verbose('Resolved { %s } = %s', body, result)

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

export interface SnippetResolver {
    resolve(snippet: Snippets, context: SnippetContext): string
}

export class DefaultSnippetResolver implements SnippetResolver {

    resolve(snippet: Snippets, context: SnippetContext): string {
        let result: string = (snippet ? Array.isArray(snippet) ? snippet : [snippet] : []).join(' ')

        // TODO Resolve numbers (\d+(?:.\d+)?)
        // TODO Resolve booleans (true | false)

        // Resolve variables & shortcuts
        result = shortcuts.reduce((result, s) => this.resolveShorcut(s, result, context), result)

        // Resolve functions
        result = this.resolveFunction(result, context)

        let unformatted = result.match(REGEX)
        if (unformatted) {
            throw new Error('Unknown pattern(s): ' + unformatted.join('; '))
        }

        return result
    }

    private resolveShorcut(shortcut: SnippetShortcut, snippet: string, context: SnippetContext): string {
        // noinspection RegExpRedundantEscape
        const regexp = new RegExp(`{([\\._-])?${shortcut.snippet}([\\._-])?}`, 'gi')

        let result: string = snippet

        if (result.search(regexp) >= 0) {
            let replacement = shortcut.replacement

            if (replacement ? replacement.search(REGEX_EXECUTABLE) >= 0 : false) {
                replacement = this.resolveFunction(replacement, context)
            }

            if (replacement) {
                result = result.replace(regexp, `$1${replacement}$2`)
            }
            else {
                result = result.replace(regexp, '')
            }
        }

        return result
    }

    private resolveFunction(snippet: string, context: SnippetContext): string {
        return snippet.replace(REGEX_EXECUTABLE, (match, body: string) => parseFunction<string>(body.trim())(context))
    }
}

type SnippetShortcut = {
    snippet: string | RegExp
    replacement: string | Snippet
}

const shortcuts: SnippetShortcut[] = [
    {
        snippet: 'iid', // Input stream identifier
        replacement: '{= input.id ;}:{= stream.index ;}'
    },
    {
        snippet: 'oid', // Output stream identifier
        replacement: '{= outputStream.index ;}'
    },
    {
        snippet: 'fn', // Input filename without extension
        replacement: '{= input.path.filename ;}'
    },
    {
        snippet: 'lng', // Input stream language | 'und'
        replacement:
            "{= " +
            "stream.tags && stream.tags.language " +
            "? stream.tags.language " +
            ": 'und' " +
            ";}"
    },
    {
        snippet: 'label', // 'forced' | 'sdh'
        replacement:
            "{= " +
            "(stream.disposition && stream.disposition.forced === 1) || (stream.tags && stream.tags.title && stream.tags.title.search(/forced/i) >= 0) " +
            "? 'forced' " +
            ": (stream.disposition && stream.disposition.hearing_impaired === 1) || (stream.tags && stream.tags.title && stream.tags.title.search(/hi|sdh/i) >= 0) " +
            "? 'sdh' " +
            ": '' " +
            ";}"
    },
]