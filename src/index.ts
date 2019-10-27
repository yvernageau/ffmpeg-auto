import * as yargs from 'yargs'
import {LoggerFactory} from './logger'
import {Profile} from './profile'
import {ProfileMapper} from './profile.mapper'
import {Scheduler} from './scheduler'
import {Watcher} from './watcher'
import {Worker} from './worker'
import {ProfileValidator} from './profile.validator';

const logger = LoggerFactory.get('config');

const version = '0.1.0';
logger.info('Running ffmpeg-auto v%s', version);

// Parse command arguments
const args = yargs
    .usage('$0 [options]')
    .strict()
    .option('i', {
        alias: 'input',
        desc: 'Input directory',
        demandOption: true,
        type: 'string',
        nargs: 1
    })
    .option('o', {
        alias: 'output',
        desc: 'Output directory',
        demandOption: true,
        type: 'string',
        nargs: 1
    })
    .option('p', {
        alias: 'profile',
        desc: 'Execution profile to apply for each input file',
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
    .option('v', {
        alias: 'verbose',
        desc: 'Makes console output more verbose',
        type: 'boolean',
        default: false
    })
    .parse();

logger.info('profile = %s', args.profile);
logger.info('input   = %s', args.input);
logger.info('output  = %s', args.output);
logger.info('watch   = %s', args.watch);
logger.info('verbose = %s', args.verbose);

// Build and validate profile
const profile: Profile = Profile.load(args.profile as string);
profile.input.directory = args.input as string;
profile.output.directory = args.output as string;

new ProfileValidator(profile).validate();

LoggerFactory.debug = args.verbose as boolean;

// Initialize watcher
const mapper: ProfileMapper = new ProfileMapper(profile);

const scheduler = new Scheduler(profile, (file, callback) => {
    mapper.apply(file)
        .then(context => new Worker(context).execute())
        .then(() => callback(null))
        .catch(reason => callback(reason))
});

const watcher = new Watcher(profile, args.watch as boolean)
    .on('add', file => scheduler.schedule(file))
    .on('remove', file => scheduler.cancel(file));

// Add the initial directory
watcher.watch(args.input as string);
