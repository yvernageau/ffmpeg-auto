import * as yargs from 'yargs'
import {ExecutorScheduler} from './executor.scheduler'
import {LoggerFactory} from './logger'
import {Profile} from './profile'
import {Watcher} from './watcher'

const logger = LoggerFactory.createDefault('config')

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

// TODO Validate profile

const scheduler = new ExecutorScheduler(profile)
const watcher = new Watcher(profile.input, args.watch, input => scheduler.schedule(input))

// Add the initial directory
watcher.watch(args.input)
