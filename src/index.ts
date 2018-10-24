import {ffprobe} from 'fluent-ffmpeg'
import * as fs from 'fs-extra'
import * as path from 'path'
import * as yargs from 'yargs'
import {LoggerFactory} from './logger'
import {InputMedia} from './media'
import {Profile} from './profile'
import {Scheduler} from './scheduler'
import {Watcher} from './watcher'
import {Worker} from './worker'

const logger = LoggerFactory.get('config')

// Parse command arguments
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

logger.info('profile = %s', args.profile)
logger.info('input   = %s', args.input)
logger.info('output  = %s', args.output)
logger.info('watch   = %s', args.watch)
logger.info('debug   = %s', args.debug)

// TODO Validate profile

const scheduler = new Scheduler(profile, (file, callback) => {
    fs.stat(file) // Ensure the file still exists
        .then(() => new Promise<InputMedia>((resolve, reject) => {
            ffprobe(file, (err, data) => {
                if (err) {
                    return reject(err.message)
                }

                const filepath = path.parse(file)
                const input = new InputMedia(0, {
                    parent: path.relative(profile.input.directory, filepath.dir),
                    filename: filepath.name,
                    extension: filepath.ext.replace(/^\./, '')
                }, data)

                resolve(input)
            })
        }))
        .then((input => new Worker(profile, input).execute()
                .then(() => callback(null))
                .catch(reason => callback(reason))
        ))
        .catch(reason => callback(reason))
})

const watcher = new Watcher(profile.input, args.watch)
    .on('schedule', file => scheduler.schedule(file))
    .on('cancel', file => scheduler.cancel(file))

// Add the initial directory
watcher.watch(args.input)
