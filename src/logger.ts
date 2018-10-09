import * as winston from 'winston'
import {format, Logger, LoggerOptions, transports} from 'winston'

export class LoggerFactory {

    static debug: boolean = false

    static createDefault(label: string): Logger {
        return winston.createLogger(LoggerFactory.getOptions(label))
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
