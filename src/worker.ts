import { interpret, getFirstState, getAvailableModules, State, Errors, PrintOptions } from '@sosml/interpreter';

let untypedGlobal: any = global;
let interpreterSettings = {
    'allowSuccessorML': false,
    'disableElaboration': false,
    'disableEvaluation': false,
    'showTypeVariablesAsUnicode': false,
    'showUsedTimeWhenAbove': -1,
};
let escapeText = ((text: string) => text.replace(/\\/g, '\\\\'));
let printOptions: PrintOptions = {
    'boldText': ((text: string) => '\\*' + text + '\\*'),
    'italicText': ((text: string) => '\\_' + text + '\\_'),
    'escapeText': escapeText,
    'fullSymbol': '>',
    'emptySymbol': ' '
};
let initialState: State = getFirstState(getAvailableModules(), interpreterSettings);
let initialStateId: number = -1; // id of the initial state, before any initial extra code.

let extraAfterCode: string = '';

class Communication {
    static handlers: any;
    static nextId: number;
    static freeIds: Set<number>;

    static init() {
        Communication.handlers = {};
        Communication.nextId = 1;
        Communication.freeIds = new Set<number>();
        untypedGlobal.onmessage = function(e: any) {
            let message = e.data;
            if (message.type) {
                if (Communication.handlers[message.type]) {
                    Communication.handlers[message.type](message.data);
                }
            }
        };
        Communication.registerHandler('settings', (settings: string | null) => {
            if (settings) {
                interpreterSettings = JSON.parse(settings);
                initialState = getFirstState(getAvailableModules(), interpreterSettings);
                initialStateId = initialState.id;
            }
        });
        Communication.registerHandler('initial', (initialCode: string | undefined) => {
            if (initialCode) {
                // Ignores any warnings / errors
                try {
                    initialStateId = initialState.id;
                    initialState = interpret(initialCode, initialState, interpreterSettings).state;
                } catch (e) {
                    // Empty!
                }
            }
        });
        Communication.registerHandler('initialSilent', (initialCode: string | undefined) => {
            if (initialCode) {
                // Ignores any warnings / errors
                try {
                    initialState = interpret(initialCode, initialState, interpreterSettings).state;
                    initialStateId = initialState.id;
                } catch (e) {
                    // Empty!
                }
            }
        });
        Communication.registerHandler('afterCode', (afterCode: string | undefined) => {
            if (afterCode) {
                extraAfterCode = afterCode;
            } else {
                extraAfterCode = '';
            }
        });
    }

    static registerHandler(type: string, func: (msg: any) => any) {
        Communication.handlers[type] = func;
    }

    static clearHandler(type: string) {
        delete Communication.handlers[type];
    }

    static sendPartialOutput(output: string) {
        untypedGlobal.postMessage({
            type: 'partial',
            data: output
        });
    }

    static sendOutputFinished() {
        untypedGlobal.postMessage({
            type: 'finished',
            data: ''
        });
    }

    static getCode(pos: any): Promise<string> {
        return new Promise((resolve, reject) => {
            untypedGlobal.postMessage({
                type: 'getcode',
                data: pos
            });
            let timeout = setTimeout(() => {
                reject('Timeout');
                Communication.clearHandler('code');
            }, 1000);
            Communication.registerHandler('code', (code) => {
                Communication.clearHandler('code');
                clearTimeout(timeout);
                resolve(code);
            });
        });
    }

    static markText(from: any, to: any, style: string): number {
        let id: number;
        if (Communication.freeIds.size > 0) {
            let it = Communication.freeIds.values();
            id = it.next().value;
            Communication.freeIds.delete(id);
        } else {
            id = Communication.nextId++;
        }
        untypedGlobal.postMessage({
            type: 'markText',
            data: {
                'from': from,
                'to': to,
                'style': style,
                'id': id
            }
        });
        return id;
    }

    static clearMarker(id: number) {
        untypedGlobal.postMessage({
            type: 'clearMarker',
            data: {
                'id': id
            }
        });
    }

    static ping() {
        untypedGlobal.postMessage({
            type: 'ping',
            data: ''
        });
    }
}

enum ErrorType {
    OK = 0, // Interpret successful
    INCOMPLETE, // The given partial string was incomplete SML code
    INTERPRETER, // The interpreter failed, e.g. compile error etc.
    SML // SML raised an exception
}

interface IncrementalStateValues {
    state: State | null;
    marker: number;
    output: string;
    error: boolean;
    successCounter: number;
    time: number | undefined;
}

class IncrementalInterpretation {
    semicoli: any[];
    data: IncrementalStateValues[];
    debounceTimeout: any;
    debounceMinimumPosition: any;
    debounceCallNecessary: boolean;
    disabled: boolean;

    constructor() {
        this.semicoli = [];
        this.data = [];

        this.disabled = false;
        this.debounceCallNecessary = false;
    }

    private extractOutput(data: IncrementalStateValues): string {
        let res: string = '';
        if (data.time !== undefined && interpreterSettings.showUsedTimeWhenAbove >= 0) {
            res += '@' + (data.time).toFixed() + '@';
        }
        res += data.output;
        return res;
    }

    clear() {
        this.semicoli.length = 0;
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i].marker !== -1) {
                Communication.clearMarker(this.data[i].marker);
            }
        }
        this.data.length = 0;
    }

    disable() {
        this.disabled = true;
        this.clear();
    }

    enable() {
        this.disabled = false;
    }

    handleChangeAt(pos: any, added: string[], removed: string[]) {
        if (this.disabled) {
            return;
        }
        this.doDebounce(pos, added, removed);
    }

    go() {
        Communication.registerHandler('interpret', (data: any) => {
            this.handleChangeAt(data.pos, data.added, data.removed);
        });
        Communication.registerHandler('clear', (data: any) => {
            this.clear();
        });
    }

    private doDebounce(pos: any, added: string[], removed: string[]) {
        clearTimeout(this.debounceTimeout);
        if (!this.debounceCallNecessary) {
            if (!this.isHandlingNecessary(pos, added, removed)) {
                Communication.ping(); // Let the frontend know I'm not dead
                return;
            } else {
                this.debounceCallNecessary = true;
            }
        }
        if (!this.debounceMinimumPosition || this.compare(pos, this.debounceMinimumPosition) === -1) {
            this.debounceMinimumPosition = pos;
        }
        this.debounceTimeout = setTimeout(() => {
            this.debounceTimeout = null;
            this.debounceCallNecessary = false;
            let minPos = this.debounceMinimumPosition;
            this.debounceMinimumPosition = null;
            this.debouncedHandleChangeAt(minPos);
        }, 400);
    }

    private async debouncedHandleChangeAt(pos: any) {
        let anchor = this.binarySearch(pos);
        anchor = this.findNonErrorAnchor(anchor);
        this.deleteAllAfter(anchor);
        let baseIndex = this.findBaseIndex(anchor);
        let basePos: any;
        if (baseIndex !== -1) {
            basePos = this.copyPos(this.semicoli[baseIndex]);
        } else {
            basePos = {line: 0, ch: 0};
        }
        let remainingText = await Communication.getCode(basePos);
        if (baseIndex !== -1) {
            remainingText = remainingText.substr(1);
            basePos.ch = basePos.ch + 1;
        }
        this.sendFinishedData(baseIndex);
        this.reEvaluateFrom(basePos, baseIndex, anchor, remainingText);
        Communication.sendOutputFinished();
    }

    private sendFinishedData(upTo: number) {
        let out = '';
        for (let i = 0; i <= upTo; i++) {
            out += this.extractOutput(this.data[i]);
        }

        Communication.sendPartialOutput(out);
    }

    private copyPos(pos: any): any {
        return {line: pos.line, ch: pos.ch};
    }

    private reEvaluateFrom(basePos: any, baseIndex: number, anchor: number, remainingText: string) {
        let splitByLine: string[] = (remainingText + extraAfterCode).split('\n');
        let lastPos = basePos;
        let partial = '';
        let errorEncountered = false;
        let previousState = (baseIndex === -1) ? null : this.data[baseIndex].state;
        let previousCounter = (baseIndex === -1) ? -1 : this.data[baseIndex].successCounter;
        for (let i = 0; i < splitByLine.length; i++) {
            let lineOffset = 0;
            if (i === 0) {
                lineOffset = basePos.ch;
            }
            let start = -1;
            let line = splitByLine[i];
            let sc: number;
            if (i !== 0) {
                partial += '\n';
            }
            while ((sc = line.indexOf(';', start + 1)) !== -1) {
                partial += line.substring(start + 1, sc);
                if (baseIndex >= anchor) {
                    // actually need to handle this

                    let semiPos = {line: (basePos.line + i), ch: sc + lineOffset};
                    if (errorEncountered) {
                        this.addErrorSemicolon(semiPos, '', Communication.markText(lastPos, semiPos, 'eval-fail'));
                        lastPos = this.copyPos(semiPos);
                        lastPos.ch++;
                        previousState = null;

                        partial = '';
                    } else {
                        let ret = this.evaluate(previousState, partial);
                        if (ret.result === ErrorType.INCOMPLETE) {
                            this.addIncompleteSemicolon(semiPos);
                            partial += ';';
                        } else if (ret.result === ErrorType.OK) {
                            let className = 'eval-success';
                            if ((previousCounter + 1) % 2 === 1) {
                                className = 'eval-success-odd';
                            }
                            this.addSemicolon(semiPos, ret.state, Communication.markText(lastPos, semiPos, className),
                                ret.warnings, ++previousCounter, ret.time);
                            lastPos = this.copyPos(semiPos);
                            lastPos.ch++;
                            previousState = ret.state;

                            partial = '';
                        } else if (ret.result === ErrorType.SML) {
                            // TODO
                            this.addSMLErrorSemicolon(semiPos, ret.error,
                                Communication.markText(lastPos, semiPos, 'eval-fail'));
                            lastPos = this.copyPos(semiPos);
                            lastPos.ch++;
                            previousState = ret.state;

                            partial = '';
                        } else {
                            // TODO: mark error position with red color
                            let errorMessage = this.getErrorMessage(ret.error, partial, lastPos);
                            this.addErrorSemicolon(semiPos, errorMessage,
                                Communication.markText(lastPos, semiPos, 'eval-fail'));
                            lastPos = this.copyPos(semiPos);
                            lastPos.ch++;
                            previousState = null;
                            errorEncountered = true;

                            partial = '';
                        }
                        // Send partial
                        if (this.data.length > 0) {
                            let output = this.extractOutput(this.data[this.data.length - 1]);
                            Communication.sendPartialOutput(output);
                        }
                    }
                } else { // no need
                    partial += ';';
                }
                baseIndex++;
                start = sc;
            }
            partial += line.substr(start + 1);
        }
    }

    private evaluate(oldState: any, partial: string): { [name: string]: any } {
        let ret: any;
        try {
            let oldtm = performance.now();
            if (oldState === null) {
                ret = interpret(partial + ';', initialState,
                    interpreterSettings);
            } else {
                ret = interpret(partial + ';', oldState,
                    interpreterSettings);
            }
            ret.time = performance.now() - oldtm;
        } catch (e) {
            if (e instanceof Errors.IncompleteError) {
                return {
                    state: null,
                    result: ErrorType.INCOMPLETE,
                    error: e,
                    warnings: [],
                    time: -1
                };
            } else {
                return {
                    state: null,
                    result: ErrorType.INTERPRETER,
                    error: e,
                    warnings: [],
                    time: -1
                };
            }
        }
        if (ret.evaluationErrored) {
            return {
                state: ret.state,
                result: ErrorType.SML,
                error: ret.error,
                warnings: ret.warnings,
                time: ret.time
            };
        } else {
            return {
                state: ret.state,
                result: ErrorType.OK,
                error: null,
                warnings: ret.warnings,
                time: ret.time
            };
        }
    }

    private getErrorMessage(error: any, partial: string, startPos: any): string {
        return '\\*' + escapeText(error.name) + '\\*: ' + escapeText(error.message);
    }

    private addSemicolon(pos: any, newState: State, marker: number, warnings: any,
                         newCounter: number, time: number | undefined) {
        this.semicoli.push(pos);
        let baseIndex = this.findBaseIndex(this.data.length - 1);
        let baseStateId = initialStateId > -1 ? initialStateId + 1 : initialState.id + 1;
        if (baseIndex !== -1) {
            let stt = this.data[baseIndex].state;
            if (stt !== null) {
                baseStateId = stt.id + 1;
            }
        }
        this.data.push({
            state: newState,
            marker: marker,
            error: false,
            output: this.computeNewStateOutput(newState, baseStateId, warnings,
                newCounter),
            successCounter: newCounter,
            time: time
        });
    }

    private addIncompleteSemicolon(pos: any) {
        this.semicoli.push(pos);
        this.data.push({
            state: null,
            marker: -1,
            error: false,
            output: '',
            successCounter: 0,
            time: undefined
        });
    }

    private addErrorSemicolon(pos: any, errorMessage: any, marker: number) {
        this.semicoli.push(pos);
        this.data.push({
            state: null,
            marker: marker,
            error: true,
            output: '\\3' + errorMessage,
            successCounter: 0,
            time: undefined
        });
    }

    private addSMLErrorSemicolon(pos: any, error: any, marker: number) {
        this.semicoli.push(pos);
        let outputErr = '\\*Uncaught SML exception\\*: ' + escapeText(error.toString()) + '\n';
        this.data.push({
            state: null,
            marker: marker,
            error: true,
            output: '\\3' + outputErr,
            successCounter: 0,
            time: undefined
        });
    }

    private computeNewStateOutput(state: State, id: number, warnings: Errors.Warning[],
                                  stateCounter: number) {
        let startWith = (stateCounter % 2 === 0) ? '\\1' : '\\2';

        let cD = new Date();
        if (cD.getMonth() === 9 && cD.getDate() >= 29) {
            printOptions.fullSymbol = '🎃'; // Halloween
        } else if (cD.getMonth() === 11 && cD.getDate() >= 24 && cD.getDate() <= 25) {
            printOptions.fullSymbol = '🍰'; // Christmas Cake Day
        } else if (cD.getMonth() === 11 && cD.getDate() === 31) {
            printOptions.fullSymbol = '🎊'; // New Year's Eve
        } else if (cD.getMonth() === 0 && cD.getDate() === 1) {
            printOptions.fullSymbol = '🎍'; // New Year's Day
        } else if (cD.getMonth() === 1 && cD.getDate() === 14) {
            printOptions.fullSymbol = '🍫'; // Valentine's Day
        } else if (cD.getMonth() === 2 && cD.getDate() === 3) {
            printOptions.fullSymbol = '🎎'; // Hinamatsuri
        } else if (cD.getMonth() === 2 && cD.getDate() === 14) {
            printOptions.fullSymbol = '🍫'; // White Day
        } else if (cD.getMonth() === 4 && cD.getDate() === 28) {
            printOptions.fullSymbol = '🥐'; // Chocolate Cornet Day (no better symbol available)
        } else if (cD.getMonth() === 6 && cD.getDate() === 7) {
            printOptions.fullSymbol = '🎋'; // Tanabata
        } else if (cD.getMonth() === 9 && cD.getDate() === 10) {
            printOptions.fullSymbol = '🍥'; // Narutomaki Day
        }

        printOptions.showTypeVariablesAsUnicode = interpreterSettings.showTypeVariablesAsUnicode;

        let res = '';
        try {
            let curst = state;
            for (let i = state.id; i >= id; --i) {
                if (curst.id === i) {
                    if (interpreterSettings.disableEvaluation) {
                        res = curst.printBasis(undefined, curst.getStaticChanges(i - 1),
                                               printOptions, 0) + res;
                    } else {
                        res = curst.printBasis(curst.getDynamicChanges(i - 1),
                                               curst.getStaticChanges(i - 1),
                                               printOptions, 0) + res;
                    }
                }
                while (curst.id >= i && curst.parent !== undefined) {
                    curst = curst.parent;
                }
            }
        } catch (e) {
            // This is a dirty hack. I am not sorry.
            if (interpreterSettings.disableEvaluation) {
                res = state.printBasis(undefined, state.getStaticChanges(id - 1), printOptions, 0);
            } else {
                res = state.printBasis(state.getDynamicChanges(id - 1),
                                      state.getStaticChanges(id - 1), printOptions, 0);
            }
        }

        let needNewline = false;
        for (let i = 0; i < warnings.length; ++i) {
            if (warnings[ i ].type === 0) {
                res += escapeText( warnings[ i ].message );
            } else if (warnings[ i ].type >= -1) {
                res += escapeText( 'WARN: ' + warnings[ i ].message );
            } else {
                res += escapeText( 'Printed: ' + warnings[ i ].message );
            }
            needNewline = !warnings[ i ].message.endsWith('\n');
        }

        if (res.trim() === '') {
            res = '(no output)\n';
        }
        if (needNewline) {
            res += '\n';
        }
        res = startWith + res;
        return res;
    }

    private stringArrayContains(arr: string[], search: string) {
        for (let i = 0; i < arr.length; i++) {
            if (arr[i].indexOf(search) !== -1) {
                return true;
            }
        }
        return false;
    }

    private isHandlingNecessary(pos: any, added: string[], removed: string[]) {
        if (this.stringArrayContains(added, ';') || this.stringArrayContains(removed, ';')) {
            return true;
        }
        if (this.semicoli.length === 0) {
            return false;
        }
        let lastSemicolon = this.semicoli[this.semicoli.length - 1];
        if (this.compare(lastSemicolon, pos) === -1) {
            return false;
        }
        return true;
    }

    private findBaseIndex(index: number): any {
        for (let i = index; i >= 0; i--) {
            if (this.data[i].state !== null) {
                return i;
            }
        }
        return -1;
    }

    private findNonErrorAnchor(anchor: number) {
        for (let i = anchor; i >= 0; i--) {
            if (!this.data[i].error) {
                return i;
            }
        }
        return -1;
    }

    private deleteAllAfter(index: number) {
        this.semicoli.length = index + 1;
        for (let i = index + 1; i < this.data.length; i++) {
            if (this.data[i].marker !== -1) {
                Communication.clearMarker(this.data[i].marker);
            }
        }
        this.data.length = index + 1;
    }

    private binarySearch(pos: any): number {
        let left = 0;
        let right = this.semicoli.length - 1;
        while (left <= right) {
            let center = Math.floor((left + right) / 2);
            let element = this.semicoli[center];
            let cmp = this.compare(pos, element);
            if (cmp === -1) {
                right = center - 1;
                if (left > right) {
                    return center - 1; // the element left of center is the next best element
                }
            } else if (cmp === 1) {
                left = center + 1;
                if (left > right) {
                    return center; // center is the next best element
                }
            } else {
                return center - 1;
            }
        }
        return -1;
    }

    private compare(posa: any, posb: any) {
        if (posa.line === posb.line) {
            return Math.sign(posa.ch - posb.ch);
        } else {
            return Math.sign(posa.line - posb.line);
        }
    }
}

Communication.init();
let ii = new IncrementalInterpretation();
ii.go();
