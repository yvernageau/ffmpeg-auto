import * as Queue from 'better-queue'
import {FSWatcher} from 'chokidar'
import {ffprobe} from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import * as path from 'path'
import * as yargs from 'yargs'
import {Executor} from './executor'
import {LoggerFactory} from './logger'
import {InputMedia} from './media'
import {Profile} from './profile'

const configLogger = LoggerFactory.get('config')
const queueLogger = LoggerFactory.get('queue')
const watcherLogger = LoggerFactory.get('watcher')

const args = yargs
    .usage('$0 [options]')
    .strict()
    .option('i', {
        alias: 'input',
        desc: 'The input directory',
        demandOption: true,
        type: 'string',
        nargs: 1
    })
    .option('o', {
        alias: 'output',
        desc: 'The outputFilename directory',
        demandOption: true,
        type: 'string',
        nargs: 1
    })
    .option('p', {
        alias: 'profile',
        desc: '',
        demandOption: true,
        type: 'string',
        nargs: 1
    })
    .option('w', {
        alias: 'watch',
        desc: 'Watches the [input] directory and executes conversion on newly added files.',
        type: 'boolean',
        default: false
    })
    .option('debug', {
        desc: 'Debug',
        type: 'boolean',
        default: false
    })
    .parse()

const profile: Profile = Profile.load(args.profile)
profile.input.directory = args.input
profile.output.directory = args.output

LoggerFactory.debug = args.debug

configLogger.info('profile = %s', args.profile)
configLogger.info('input   = %s', args.input)
configLogger.info('output  = %s', args.output)
configLogger.info('watch   = %s', args.watch)

// TODO Validate profile

let queueCount = 0
const queue = new Queue(
    {
        id: ((task, cb) => cb(null, `#${++queueCount}`)),
        process: (input: InputMedia, callback) => {
            new Executor(profile, input)
                .execute()
                .catch(reason => callback(reason))
                .then(() => callback(null))
        }
    })
    .on('task_queued', (id, input: InputMedia) => {
        queueLogger.info('%s - Enqueued: %s', id, input.resolvePath())
    })
    .on('task_started', id => {
        queueLogger.info('%s - Started', id)
    })
    .on('task_finish', id => {
        queueLogger.info('%s - Done', id)
    })
    .on('task_failed', (id, errorMessage) => {
        queueLogger.error('%s - Failed: %s', id, errorMessage)
    })
    .on('error', (id, err) => {
        queueLogger.error('%s - %s', id, err)
    })

const watcher: FSWatcher = new FSWatcher(
    {
        awaitWriteFinish: true,
        alwaysStat: true,
        ignorePermissionErrors: true,
        persistent: args.watch
    })
    .on('add', file => {
        getMedia(file)
            .then(input => queue.push(input))
            .catch(reason => watcherLogger.warn("'%s' has been ignored: %s", file, reason))
    })
    .on('addDir', dir => {
        watcherLogger.info("Watching: '%s' ...", dir)
        watcher.add(dir)
    })
    .on('unlinkDir', dir => {
        watcherLogger.info("Unwatching: '%s'", dir)
        watcher.unwatch(dir)
    })

// Add the initial directory
watcher.add(args.input)

// Add exit listeners
process.on('exit', () => {
    watcher.close()
    queue.destroy(() => {
    })
})

async function getMedia(file: string): Promise<InputMedia> {
    return new Promise<InputMedia>((resolve, reject) => {
        if (isAlreadyProcessed(file)) {
            return reject("File has already been processed (registered in 'excludes.list')")
        }
        else if (isExcludedFromProfile(file)) {
            return reject("File extension is excluded in profile")
        }
        else {
            ffprobe(file, ['-show_chapters'], (err, data) => {
                if (!err && data && !isNaN(data.format.duration)) {
                    return resolve(new InputMedia(0, path.parse(file), data))
                }
                else if (err) {
                    return reject(err)
                }
                else {
                    return reject('File is not a media')
                }
            })
        }
    })
}

function isExcludedFromProfile(file: string): boolean {
    // TODO Move to configuration validator
    if (!profile.input) {
        throw new Error(`Missing 'input' in '${profile.id}', all files are excluded by default`)
    }
    else if (!profile.input.includes && !profile.input.excludes) {
        throw new Error(`Missing 'includes' or 'excludes' in '${profile.id}#input', all files are excluded by default`)
    }

    const extension = path.parse(file).ext.replace(/^\./, '')

    // Excluded by default
    let includes: boolean = false
    let excludes: boolean = true

    if (profile.input.includes) {
        includes = extension.search(profile.input.includes) >= 0
    }

    if (profile.input.excludes) {
        excludes = extension.search(profile.input.excludes) >= 0
    }

    return !includes && excludes
}

function isAlreadyProcessed(file: string): boolean {
    const excludesListPath = path.resolve(profile.output.directory, 'excludes.list')

    try {
        let stats = fs.statSync(excludesListPath)
        if (!stats) { // Excludes list does not exist
            return false
        }
        else {
            let lines = fs.readFileSync(excludesListPath, {encoding: 'utf-8'}).split('\n')
            return !!lines.filter(l => l === path.relative(profile.input.directory, file))
        }
    }
    catch (e) {
        return false
    }
}