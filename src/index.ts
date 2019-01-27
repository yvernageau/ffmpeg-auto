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

logger.info('profile = %s', args.profile)
logger.info('input   = %s', args.input)
logger.info('output  = %s', args.output)
logger.info('watch   = %s', args.watch)
logger.info('debug   = %s', args.debug)

const profile: Profile = Profile.load(args.profile as string)
profile.input.directory = args.input as string
profile.output.directory = args.output as string

LoggerFactory.debug = args.debug

// region Profile validation

// Remove 'mappings' and 'mapping[].options' where 'skip === true'
profile.output.mappings = profile.output.mappings.filter(m => !m.skip)
profile.output.mappings.filter(m => m.options && m.options.length > 0).forEach(m => m.options = m.options.filter(o => !o.skip))

if (!profile.input) throw new Error("Missing 'input' in profile")
if (!profile.output) throw new Error("Missing 'output' in profile")
if (!profile.input.include && !profile.input.exclude) throw new Error("Missing 'input.include' or 'input.exclude' in profile, all files are excluded by default")
if (!profile.output.mappings || profile.output.mappings.length === 0) throw new Error("No 'output.mappings' defined")
if (profile.output.mappings.some(m => !m.output)) throw new Error("'output' must be defined for each 'mappings'")

// endregion

const mapper: ProfileMapper = new ProfileMapper(profile)

const scheduler = new Scheduler(profile, (file, callback) => {
    mapper.apply(file)
        .then(context => new Worker(context).execute())
        .then(() => callback(null))
        .catch(reason => callback(reason))
})

const watcher = new Watcher(profile, args.watch as boolean)
    .on('add', file => scheduler.schedule(file))
    .on('remove', file => scheduler.cancel(file))

// Add the initial directory
watcher.watch(args.input as string)
