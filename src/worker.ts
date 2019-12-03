import { interpret, getFirstState, getAvailableModules, State, DynamicBasis, StaticBasis,
         Types, Errors, Values, IdentifierStatus } from '@sosml/interpreter';

let untypedGlobal: any = global;
let interpreterSettings = {
    'allowUnicodeInStrings': false,
    'allowSuccessorML': false,
    'disableElaboration': false,
    'disableEvaluation': false,
    'allowLongFunctionNames': false
};
let initialState: State = getFirstState(getAvailableModules(), interpreterSettings);

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
        Communication.registerHandler('settings', (settings: any) => {
            if (settings) {
                interpreterSettings = JSON.parse(settings);
                initialState = getFirstState(getAvailableModules(), interpreterSettings);
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
            out += this.data[i].output;
        }

        Communication.sendPartialOutput(out);
    }

    private copyPos(pos: any): any {
        return {line: pos.line, ch: pos.ch};
    }

    private reEvaluateFrom(basePos: any, baseIndex: number, anchor: number, remainingText: string) {
        let splitByLine: string[] = remainingText.split('\n');
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
                                ret.warnings, ++previousCounter);
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
                            let output = this.data[this.data.length - 1].output;
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
            if (oldState === null) {
                ret = interpret(partial + ';', initialState,
                    interpreterSettings);
            } else {
                ret = interpret(partial + ';', oldState,
                    interpreterSettings);
            }
        } catch (e) {
            if (e instanceof Errors.IncompleteError) {
                return {
                    state: null,
                    result: ErrorType.INCOMPLETE,
                    error: e,
                    warnings: []
                };
            } else {
                return {
                    state: null,
                    result: ErrorType.INTERPRETER,
                    error: e,
                    warnings: []
                };
            }
        }
        if (ret.evaluationErrored) {
            return {
                state: ret.state,
                result: ErrorType.SML,
                error: ret.error,
                warnings: ret.warnings
            };
        } else {
            return {
                state: ret.state,
                result: ErrorType.OK,
                error: null,
                warnings: ret.warnings
            };
        }
    }

    private getErrorMessage(error: any, partial: string, startPos: any): string {
        return '\\*' + this.outputEscape(error.name) + '\\*: ' +
            this.outputEscape(error.message);
    }

    private addSemicolon(pos: any, newState: State, marker: number, warnings: any,
                         newCounter: number) {
        this.semicoli.push(pos);
        let baseIndex = this.findBaseIndex(this.data.length - 1);
        let baseStateId = initialState.id + 1;
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
            successCounter: newCounter
        });
    }

    private addIncompleteSemicolon(pos: any) {
        this.semicoli.push(pos);
        this.data.push({
            state: null,
            marker: -1,
            error: false,
            output: '',
            successCounter: 0
        });
    }

    private addErrorSemicolon(pos: any, errorMessage: any, marker: number) {
        this.semicoli.push(pos);
        this.data.push({
            state: null,
            marker: marker,
            error: true,
            output: '\\3' + errorMessage,
            successCounter: 0
        });
    }

    private addSMLErrorSemicolon(pos: any, error: any, marker: number) {
        this.semicoli.push(pos);
        let outputErr = '\\*Uncaught SML exception\\*: ' + this.outputEscape(error.toString()) + '\n';
        this.data.push({
            state: null,
            marker: marker,
            error: true,
            output: '\\3' + outputErr,
            successCounter: 0
        });
    }

    private outputEscape(str: string): string {
        return str.replace(/\\/g, "\\\\");
    }

    private printBasis(state: State, dynamicBasis: DynamicBasis | undefined,
                       staticBasis: StaticBasis | undefined, indent: number = 0) {
        let out = '';
        let fullst = '>';
        let emptyst = ' ';
        let cD = new Date();
        if (cD.getMonth() === 9 && cD.getDate() >= 25) {
            fullst = "🎃";
        } else if (cD.getMonth() === 11 && cD.getDate() >= 24 && cD.getDate() <= 26) {
            fullst = "🎄";
        } else if (cD.getMonth() === 11 && cD.getDate() === 31) {
            fullst = "🎊";
        } else if (cD.getMonth() === 0 && cD.getDate() === 1) {
            fullst = "🎆";
        } else if (cD.getMonth() === 1 && cD.getDate() === 14) {
            fullst = "🍫";
        } else if (cD.getMonth() === 2 && cD.getDate() === 14) {
            fullst = "🍫";
        } else if (cD.getMonth() === 6 && cD.getDate() === 7) {
            fullst = "🎋";
        }
        let stsym = indent === 0 ? fullst : emptyst;

        let istr = '';
        for( let i = 0; i < indent; ++i ) {
            istr += '  ';
        }
        if( dynamicBasis === undefined && staticBasis !== undefined ) {
            for( let i in staticBasis.valueEnvironment ) {
                if( staticBasis.valueEnvironment.hasOwnProperty( i ) ) {
                    out += stsym + ' ' + istr + this.printBinding( state,
                        [ i, undefined,
                            staticBasis.getValue( i ) ] ) + '\n';
                }
            }

            for( let i in staticBasis.typeEnvironment ) {
                if( staticBasis.typeEnvironment.hasOwnProperty( i ) ) {
                    let sbtp = staticBasis.getType( i );
                    if( sbtp !== undefined ) {
                        if( sbtp.type instanceof Types.CustomType ) {
                            out += stsym + ' ' + istr + 'datatype \\*' + sbtp.type
                            + '\\* : {\n'
                            for( let j of sbtp.constructors ) {
                                out += emptyst + '   ' + istr + this.printBinding( state,
                                    [ j, undefined, staticBasis.getValue( j ) ] ) + '\n';
                            }
                            out += emptyst + ' ' + istr + '};\n';
                        }
                    }
                }
            }

            for( let i in staticBasis.typeEnvironment ) {
                if( staticBasis.typeEnvironment.hasOwnProperty( i ) ) {
                    let sbtp = staticBasis.getType( i );
                    if( sbtp !== undefined ) {
                        if( sbtp.type instanceof Types.FunctionType ) {
                            out += stsym + ' ' + istr + 'type \\*'
                            + sbtp.type.parameterType + ' = '
                            + sbtp.type.returnType + '\\*;\n';
                        }
                    }
                }
            }

            for( let i in staticBasis.structureEnvironment ) {
                if( staticBasis.structureEnvironment.hasOwnProperty( i ) ) {
                    out += stsym + ' ' + istr + 'structure \\*' + i + '\\*: sig\n';
                    if( staticBasis ) {
                        out += this.printBasis( state, undefined,
                            staticBasis.getStructure( i ), indent + 1 );
                    } else {
                        out += this.printBasis( state, undefined,
                            undefined, indent + 1 );
                    }
                    out += emptyst + ' ' + istr + 'end;\n';
                }
            }

        } else if ( staticBasis !== undefined && dynamicBasis !== undefined ) {
            for( let i in dynamicBasis.valueEnvironment ) {
                if( dynamicBasis.valueEnvironment.hasOwnProperty( i ) ) {
                    if( staticBasis ) {
                        out += stsym + ' ' + istr + this.printBinding( state,
                            [ i, dynamicBasis.valueEnvironment[ i ],
                                staticBasis.getValue( i ) ], false ) + '\n';
                    } else {
                        out += stsym + ' ' + istr + this.printBinding( state,
                            [ i, dynamicBasis.valueEnvironment[ i ], undefined ], false ) + '\n';
                    }
                }
            }

            for( let i in dynamicBasis.typeEnvironment ) {
                if( dynamicBasis.typeEnvironment.hasOwnProperty( i ) ) {
                    if( staticBasis.typeEnvironment.hasOwnProperty( i ) ) {
                        let sbtp = staticBasis.getType( i );
                        if( sbtp !== undefined ) {
                            if( sbtp.type instanceof Types.CustomType ) {
                                out += stsym + ' ' + istr + 'datatype \\*' + sbtp.type
                                    + '\\* = {\n'
                                for( let j of sbtp.constructors ) {
                                    out += emptyst + '   ' + istr + this.printBinding( state,
                                        [ j, dynamicBasis.valueEnvironment[ j ],
                                        staticBasis.getValue( j ) ] ) + '\n';
                                }
                                out += emptyst + ' ' + istr + '};\n';
                            }
                        }
                    }
                }
            }

            for( let i in dynamicBasis.typeEnvironment ) {
                if( dynamicBasis.typeEnvironment.hasOwnProperty( i ) ) {
                    if( staticBasis.typeEnvironment.hasOwnProperty( i ) ) {
                        let sbtp = staticBasis.getType( i );
                        if( sbtp !== undefined ) {
                            if( sbtp.type instanceof Types.FunctionType ) {
                                out += stsym + ' ' + istr + 'type \\*'
                                + sbtp.type.parameterType + ' = '
                                + sbtp.type.returnType + '\\*;\n';
                            }
                        }
                    }
                }
            }

            for( let i in dynamicBasis.structureEnvironment ) {
                if( dynamicBasis.structureEnvironment.hasOwnProperty( i ) ) {
                    out += stsym + ' ' + istr + 'structure \\*' + i + '\\* = struct\n';
                    if( staticBasis ) {
                        out += this.printBasis( state, dynamicBasis.getStructure( i ),
                            staticBasis.getStructure( i ), indent + 1 );
                    } else {
                        out += this.printBasis( state, dynamicBasis.getStructure( i ),
                            undefined, indent + 1 );
                    }
                    out += emptyst + ' ' + istr + 'end;\n';
                }
            }
        }
        return out;
    }


    private computeNewStateOutput(state: State, id: number, warnings: Errors.Warning[],
                                  stateCounter: number) {
        let startWith = (stateCounter % 2 === 0) ? '\\1' : '\\2';
        let res = '';
        try {
            let curst = state;
            for (let i = state.id; i >= id; --i) {
                if (curst.id === i) {
                    if (interpreterSettings.disableEvaluation) {
                        res = this.printBasis(curst, undefined,
                                              curst.getStaticChanges(i - 1), 0) + res;
                    } else {
                        res = this.printBasis(curst, curst.getDynamicChanges(i - 1),
                                              curst.getStaticChanges(i - 1), 0) + res;
                    }
                }
                while (curst.id >= i && curst.parent !== undefined) {
                    curst = curst.parent;
                }
            }
        } catch (e) {
            // This is a dirty hack. I am not sorry.
            if (interpreterSettings.disableEvaluation) {
                res = this.printBasis(state, undefined,
                                      state.getStaticChanges(id - 1), 0);
            } else {
                res = this.printBasis(state, state.getDynamicChanges(id - 1),
                                      state.getStaticChanges(id - 1), 0);
            }
        }

        let needNewline = false;
        for( let i = 0; i < warnings.length; ++i ) {
            if( warnings[ i ].type >= -1 ) {
                res += this.outputEscape( 'WARN: ' + warnings[ i ].message );
            } else {
                res +=  this.outputEscape( 'Printed: ' + warnings[ i ].message );
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

    private printBinding( state: State, bnd: [string, [Values.Value, IdentifierStatus] | undefined,
                         [Types.Type, IdentifierStatus] | undefined], acon: boolean =  true): string {
        let res = '';

        let value: Values.Value | undefined;
        let bnd1 = bnd[1];
        if ( bnd1 !== undefined ) {
            value = bnd1[0];
        }
        let type: Types.Type | undefined;
        let bnd2 = bnd[2];
        if ( bnd2 !== undefined ) {
            type = bnd2[0];
        }

        if ( ( value instanceof Values.ValueConstructor
            || ( type instanceof Types.CustomType && type + '' !== 'exn' ) ) && acon ) {
            res += 'con';
        } else if ( value instanceof Values.ExceptionConstructor
            || type + '' === 'exn' ) {
            res += 'exn';
        } else {
            res += 'val';
        }

        if (value) {
            if (type && type.isOpaque()) {
                res += ' \\*' + bnd[0] + ' = <' + this.outputEscape(type.getOpaqueName()) + '>\\*';
            } else {
                res += ' \\*' + bnd[0] + ' = ' + this.outputEscape(value.toString(state)) + '\\*';
            }
        } else {
            res += ' \\*' + bnd[0] + '\\*';
        }

        if (type) {
            return res + ': \\_' + this.outputEscape(type.toString(interpreterSettings)) + '\\_;';
        } else {
            return res + ': undefined;';
        }
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
