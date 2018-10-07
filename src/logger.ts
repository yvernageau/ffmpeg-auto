import * as winston from 'winston'
import {format, Logger, LoggerOptions, transports} from 'winston'

const loggers = winston.loggers

export class LoggerFactory {

    static _debug: boolean = true

    static get debug(): boolean {
        return this._debug
    }

    static set debug(debug: boolean) {
        if (this._debug !== debug) {
            this._debug = debug
            loggers.loggers.forEach(l => l.level = debug ? 'debug' : 'info')
        }
    }

    static get(label: string): Logger {
        let logger = loggers.has(label) ? loggers.get(label) : loggers.add(label, LoggerFactory.getOptions(label))

        if (logger.level !== 'debug' && LoggerFactory._debug) {
            logger.level = 'debug'
        }

        return logger
    }

    private static getOptions(label: string): LoggerOptions {
        return {
            level: LoggerFactory._debug ? 'debug' : 'info',
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
