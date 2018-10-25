import * as yargs from 'yargs'
import {LoggerFactory} from './logger'
import {Profile} from './profile'
import {ProfileMapper} from './profile.mapper'
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
        desc: 'The output directory',
        demandOption: true,
        type: 'string',
        nargs: 1
    })
    .option('p', {
        alias: 'profile',
        desc: 'The execution profile to apply for each input file',
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
        desc: 'Display debug information',
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

const mapper: ProfileMapper = new ProfileMapper(profile)

const scheduler = new Scheduler(profile, (file, callback) => {
    mapper.apply(file)
        .then(context => new Worker(context).execute())
        .then(() => callback(null))
        .catch(reason => callback(reason))
})

const watcher = new Watcher(profile, args.watch)
    .on('add', file => scheduler.schedule(file))
    .on('remove', file => scheduler.cancel(file))

// Add the initial directory
watcher.watch(args.input)
