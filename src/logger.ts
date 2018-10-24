import * as winston from 'winston'
import {format, Logger, LoggerOptions, transports} from 'winston'

export class LoggerFactory {

    static _debug: boolean = false

    static get debug() {
        return LoggerFactory._debug
    }

    static set debug(debug: boolean) {
        if (debug !== LoggerFactory._debug) {
            LoggerFactory._debug = debug
            winston.loggers.loggers.forEach(value => {
                value.level = debug ? 'debug' : 'info'
            })
        }
    }

    static get(label: string): Logger {
        if (winston.loggers.has(label)) {
            return winston.loggers.get(label)
        }
        else {
            return winston.loggers.add(label, LoggerFactory.getOptions(label))
        }
    }

    private static getOptions(label: string): LoggerOptions {
        return {
            level: LoggerFactory.debug ? 'debug' : 'info',
            format: format.combine(
                format.label({label: label}),
                format.timestamp(),
                format.colorize(),
                format.splat(),
                format.printf(l => `${l.level} - ${l.timestamp}: [${l.label}] ${l.message}`)
            ),
            transports: [
                new transports.Console()
            ]
        }
    }
}
