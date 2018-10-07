import '@babel/polyfill'
import * as BetterQueue from 'better-queue'
import {FSWatcher} from 'chokidar'
import {ffprobe} from 'fluent-ffmpeg'
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

configLogger.info('profile = %s', profile.name)
configLogger.info('input   = %s', args.input)
configLogger.info('output  = %s', args.output)
configLogger.info('watch   = %s', args.watch)

let queueCount = 0
const queue: BetterQueue = new BetterQueue(
    {
        id: ((task, cb) => cb(null, `#${++queueCount}`)),
        process: (input: InputMedia, callback) => {
            new Executor(profile, input)
                .execute()
                .catch(reason => callback(reason))
                .then(result => callback(null, result))
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
        ignorePermissionErrors: true,
        persistent: args.watch
    })
    .on('add', file => {
        ffprobe(file, [], (err, data) => {
            if (!err && data && !isNaN(data.format.duration)) {
                watcherLogger.debug("Added: '%s'", file)
                queue.push(new InputMedia(0, path.parse(file), data))
            }
            else {
                if (err) {
                    watcherLogger.warn("Ignored: '%s': %s", file, err)
                }
                else {
                    watcherLogger.warn("Ignored: '%s'", file)
                }
            }
        })
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
