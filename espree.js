/**
 * @fileoverview Main Espree file that converts Acorn into Esprima output.
 *
 * This file contains code from the following MIT-licensed projects:
 * 1. Acorn
 * 2. Babylon
 * 3. Babel-ESLint
 *
 * This file also contains code from Esprima, which is BSD licensed.
 *
 * Acorn is Copyright 2012-2015 Acorn Contributors (https://github.com/marijnh/acorn/blob/master/AUTHORS)
 * Babylon is Copyright 2014-2015 various contributors (https://github.com/babel/babel/blob/master/packages/babylon/AUTHORS)
 * Babel-ESLint is Copyright 2014-2015 Sebastian McKenzie <sebmck@gmail.com>
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright
 *   notice, this list of conditions and the following disclaimer.
 * * Redistributions in binary form must reproduce the above copyright
 *   notice, this list of conditions and the following disclaimer in the
 *   documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * Esprima is Copyright (c) jQuery Foundation, Inc. and Contributors, All Rights Reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 *   * Redistributions of source code must retain the above copyright
 *     notice, this list of conditions and the following disclaimer.
 *   * Redistributions in binary form must reproduce the above copyright
 *     notice, this list of conditions and the following disclaimer in the
 *     documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
/* eslint no-undefined:0, no-use-before-define: 0 */

"use strict";

const astNodeTypes = require("./lib/ast-node-types"),
    commentAttachment = require("./lib/comment-attachment"),
    TokenTranslator = require("./lib/token-translator"),
    acornJSX = require("acorn-jsx/inject"),
    rawAcorn = require("acorn");


const acorn = acornJSX(rawAcorn);
const DEFAULT_ECMA_VERSION = 5;
let lookahead,
    extra,
    lastToken;

/**
 * Resets the extra object to its default.
 * @returns {void}
 * @private
 */
function resetExtra() {
    extra = {
        tokens: null,
        range: false,
        loc: false,
        comment: false,
        comments: [],
        tolerant: false,
        errors: [],
        strict: false,
        ecmaFeatures: {},
        ecmaVersion: DEFAULT_ECMA_VERSION,
        isModule: false
    };
}

const tt = acorn.tokTypes,
    getLineInfo = acorn.getLineInfo;

// custom type for JSX attribute values
tt.jsxAttrValueToken = {};

/**
 * Normalize ECMAScript version from the initial config
 * @param  {number} ecmaVersion ECMAScript version from the initial config
 * @returns {number} normalized ECMAScript version
 */
function normalizeEcmaVersion(ecmaVersion) {
    if (typeof ecmaVersion === "number") {
        let version = ecmaVersion;

        // Calculate ECMAScript edition number from official year version starting with
        // ES2015, which corresponds with ES6 (or a difference of 2009).
        if (version >= 2015) {
            version -= 2009;
        }

        switch (version) {
            case 3:
            case 5:
            case 6:
            case 7:
            case 8:
            case 9:
            case 10:
                return version;

            default:
                throw new Error("Invalid ecmaVersion.");
        }
    } else {
        return DEFAULT_ECMA_VERSION;
    }
}

/**
 * Determines if a node is valid given the set of ecmaFeatures.
 * @param {ASTNode} node The node to check.
 * @returns {boolean} True if the node is allowed, false if not.
 * @private
 */
function isValidNode(node) {
    switch (node.type) {
        case "ImportDeclaration":
        case "ExportNamedDeclaration":
        case "ExportDefaultDeclaration":
        case "ExportAllDeclaration":
            return extra.isModule;

        default:
            return true;
    }
}

/**
 * Performs last-minute Esprima-specific compatibility checks and fixes.
 * @param {ASTNode} result The node to check.
 * @returns {ASTNode} The finished node.
 * @private
 * @this acorn.Parser
 */
function esprimaFinishNode(result) {

    // ensure that parsed node was allowed through ecmaFeatures
    if (!isValidNode(result)) {
        this.unexpected(result.start);
    }

    // Acorn doesn't count the opening and closing backticks as part of templates
    // so we have to adjust ranges/locations appropriately.
    if (result.type === "TemplateElement") {

        // additional adjustment needed if ${ is the last token
        const terminalDollarBraceL = this.input.slice(result.end, result.end + 2) === "${";

        if (result.range) {
            result.range[0]--;
            result.range[1] += (terminalDollarBraceL ? 2 : 1);
        }

        if (result.loc) {
            result.loc.start.column--;
            result.loc.end.column += (terminalDollarBraceL ? 2 : 1);
        }
    }

    if (extra.attachComment) {
        commentAttachment.processComment(result);
    }

    if (result.type.indexOf("Function") > -1 && !result.generator) {
        result.generator = false;
    }

    return result;
}

/**
 * Determines if a token is valid given the set of ecmaFeatures.
 * @param {acorn.Parser} parser The parser to check.
 * @returns {boolean} True if the token is allowed, false if not.
 * @private
 */
function isValidToken(parser) {
    const ecma = extra.ecmaFeatures;
    const type = parser.type;

    switch (type) {
        case tt.jsxName:
        case tt.jsxText:
        case tt.jsxTagStart:
        case tt.jsxTagEnd:
            return ecma.jsx;

        // https://github.com/ternjs/acorn/issues/363
        case tt.regexp:
            if (extra.ecmaVersion < 6 && parser.value.flags && parser.value.flags.indexOf("y") > -1) {
                return false;
            }

            return true;

        default:
            return true;
    }
}

/**
 * Injects esprimaFinishNode into the finishNode process.
 * @param {Function} finishNode Original finishNode function.
 * @returns {ASTNode} The finished node.
 * @private
 */
function wrapFinishNode(finishNode) {
    /* eslint-disable-next-line valid-jsdoc */
    return /** @this acorn.Parser */ function(node, type, pos, loc) {
        const result = finishNode.call(this, node, type, pos, loc);

        return esprimaFinishNode.call(this, result);
    };
}

acorn.plugins.espree = function(instance) {

    instance.extend("finishNode", wrapFinishNode);

    instance.extend("finishNodeAt", wrapFinishNode);

    instance.extend("next", next =>
    /** @this acorn.Parser */ function() {
            if (!isValidToken(this)) {
                this.unexpected();
            }
            return next.call(this);
        });

    instance.extend("parseTopLevel", parseTopLevel =>
    /** @this acorn.Parser */ function(node) {
            if (extra.ecmaFeatures.impliedStrict && this.options.ecmaVersion >= 5) {
                this.strict = true;
            }
            return parseTopLevel.call(this, node);
        });

    /**
     * Overwrites the default raise method to throw Esprima-style errors.
     * @param {int} pos The position of the error.
     * @param {string} message The error message.
     * @throws {SyntaxError} A syntax error.
     * @returns {void}
     */
    instance.raise = instance.raiseRecoverable = function(pos, message) {
        const loc = getLineInfo(this.input, pos);
        const err = new SyntaxError(message);

        err.index = pos;
        err.lineNumber = loc.line;
        err.column = loc.column + 1; // acorn uses 0-based columns
        throw err;
    };

    /**
     * Overwrites the default unexpected method to throw Esprima-style errors.
     * @param {int} pos The position of the error.
     * @throws {SyntaxError} A syntax error.
     * @returns {void}
     */
    instance.unexpected = function(pos) {
        let message = "Unexpected token";

        if (pos !== null && pos !== undefined) {
            this.pos = pos;

            if (this.options.locations) {
                while (this.pos < this.lineStart) {
                    this.lineStart = this.input.lastIndexOf("\n", this.lineStart - 2) + 1;
                    --this.curLine;
                }
            }

            this.nextToken();
        }

        if (this.end > this.start) {
            message += ` ${this.input.slice(this.start, this.end)}`;
        }

        this.raise(this.start, message);
    };

    /*
    * Esprima-FB represents JSX strings as tokens called "JSXText", but Acorn-JSX
    * uses regular tt.string without any distinction between this and regular JS
    * strings. As such, we intercept an attempt to read a JSX string and set a flag
    * on extra so that when tokens are converted, the next token will be switched
    * to JSXText via onToken.
    */
    instance.extend("jsx_readString", jsxReadString =>
    /** @this acorn.Parser */ function(quote) {
            const result = jsxReadString.call(this, quote);

            if (this.type === tt.string) {
                extra.jsxAttrValueToken = true;
            }

            return result;
        });
};

//------------------------------------------------------------------------------
// Tokenizer
//------------------------------------------------------------------------------

/**
 * Tokenizes the given code.
 * @param {string} inputCode The code to tokenize.
 * @param {Object} inputOptions Options defining how to tokenize.
 * @returns {Token[]} An array of tokens.
 * @throws {SyntaxError} If the input code is invalid.
 * @private
 */
function tokenize(inputCode, inputOptions) {
    const translator = new TokenTranslator(tt, inputCode);
    const toString = String;
    const options = Object.assign({}, inputOptions);
    const code = typeof inputCode !== "string" && !(inputCode instanceof String)
        ? toString(inputCode) : inputCode;

    let tokens,
        impliedStrict;

    lookahead = null;

    const acornOptions = {
        ecmaVersion: DEFAULT_ECMA_VERSION,
        plugins: {
            espree: true
        }
    };

    resetExtra();

    // Of course we collect tokens here.
    options.tokens = true;
    extra.tokens = [];

    extra.range = (typeof options.range === "boolean") && options.range;
    acornOptions.ranges = extra.range;

    extra.loc = (typeof options.loc === "boolean") && options.loc;
    acornOptions.locations = extra.loc;

    extra.comment = typeof options.comment === "boolean" && options.comment;

    if (extra.comment) {
        acornOptions.onComment = function(...args) {
            const comment = convertAcornCommentToEsprimaComment.call(this, ...args);

            extra.comments.push(comment);
        };
    }

    extra.tolerant = typeof options.tolerant === "boolean" && options.tolerant;

    acornOptions.ecmaVersion = extra.ecmaVersion = normalizeEcmaVersion(options.ecmaVersion);

    // apply parsing flags
    if (options.ecmaFeatures && typeof options.ecmaFeatures === "object") {
        extra.ecmaFeatures = Object.assign({}, options.ecmaFeatures);
        impliedStrict = extra.ecmaFeatures.impliedStrict;
        extra.ecmaFeatures.impliedStrict = typeof impliedStrict === "boolean" && impliedStrict;
    }

    try {
        const tokenizer = acorn.tokenizer(code, acornOptions);

        while ((lookahead = tokenizer.getToken()).type !== tt.eof) {
            translator.onToken(lookahead, extra);
        }

        // filterTokenLocation();
        tokens = extra.tokens;

        if (extra.comment) {
            tokens.comments = extra.comments;
        }
        if (extra.tolerant) {
            tokens.errors = extra.errors;
        }
    } catch (e) {
        throw e;
    }
    return tokens;
}

//------------------------------------------------------------------------------
// Parser
//------------------------------------------------------------------------------


/**
 * Converts an Acorn comment to a Esprima comment.
 * @param {boolean} block True if it's a block comment, false if not.
 * @param {string} text The text of the comment.
 * @param {int} start The index at which the comment starts.
 * @param {int} end The index at which the comment ends.
 * @param {Location} startLoc The location at which the comment starts.
 * @param {Location} endLoc The location at which the comment ends.
 * @returns {Object} The comment object.
 * @private
 */
function convertAcornCommentToEsprimaComment(block, text, start, end, startLoc, endLoc) {
    const comment = {
        type: block ? "Block" : "Line",
        value: text
    };

    if (typeof start === "number") {
        comment.start = start;
        comment.end = end;
        comment.range = [start, end];
    }

    if (typeof startLoc === "object") {
        comment.loc = {
            start: startLoc,
            end: endLoc
        };
    }

    return comment;
}

/**
 * Parses the given code.
 * @param {string} inputCode The code to tokenize.
 * @param {Object} inputOptions Options defining how to tokenize.
 * @returns {ASTNode} The "Program" AST node.
 * @throws {SyntaxError} If the input code is invalid.
 * @private
 */
function parse(inputCode, inputOptions) {
    const toString = String;
    const acornOptions = {
        ecmaVersion: DEFAULT_ECMA_VERSION,
        plugins: {
            espree: true
        }
    };
    const code = typeof inputCode !== "string" && !(inputCode instanceof String)
        ? toString(inputCode) : inputCode;
    let translator,
        impliedStrict;

    lastToken = null;


    resetExtra();
    commentAttachment.reset();

    if (typeof inputOptions !== "undefined") {
        extra.range = (typeof inputOptions.range === "boolean") && inputOptions.range;
        extra.loc = (typeof inputOptions.loc === "boolean") && inputOptions.loc;
        extra.attachComment = (typeof inputOptions.attachComment === "boolean") && inputOptions.attachComment;

        if (extra.loc && inputOptions.source !== null && inputOptions.source !== undefined) {
            extra.source = toString(inputOptions.source);
        }

        if (typeof inputOptions.tokens === "boolean" && inputOptions.tokens) {
            extra.tokens = [];
            translator = new TokenTranslator(tt, code);
        }
        if (typeof inputOptions.comment === "boolean" && inputOptions.comment) {
            extra.comment = true;
            extra.comments = [];
        }
        if (typeof inputOptions.tolerant === "boolean" && inputOptions.tolerant) {
            extra.errors = [];
        }
        if (extra.attachComment) {
            extra.range = true;
            extra.comments = [];
            commentAttachment.reset();
        }

        acornOptions.ecmaVersion = extra.ecmaVersion = normalizeEcmaVersion(inputOptions.ecmaVersion);

        if (inputOptions.sourceType === "module") {
            extra.isModule = true;

            // modules must be in 6 at least
            if (acornOptions.ecmaVersion < 6) {
                acornOptions.ecmaVersion = 6;
                extra.ecmaVersion = 6;
            }

            acornOptions.sourceType = "module";
        }

        // apply parsing flags after sourceType to allow overriding
        if (inputOptions.ecmaFeatures && typeof inputOptions.ecmaFeatures === "object") {
            extra.ecmaFeatures = Object.assign({}, inputOptions.ecmaFeatures);
            impliedStrict = extra.ecmaFeatures.impliedStrict;
            extra.ecmaFeatures.impliedStrict = typeof impliedStrict === "boolean" && impliedStrict;
            if (inputOptions.ecmaFeatures.globalReturn) {
                acornOptions.allowReturnOutsideFunction = true;
            }
        }


        acornOptions.onToken = function(token) {
            if (extra.tokens) {
                translator.onToken(token, extra);
            }
            if (token.type !== tt.eof) {
                lastToken = token;
            }
        };

        if (extra.attachComment || extra.comment) {
            acornOptions.onComment = function(...args) {
                const comment = convertAcornCommentToEsprimaComment.apply(this, args);

                extra.comments.push(comment);

                if (extra.attachComment) {
                    commentAttachment.addComment(comment);
                }
            };
        }

        if (extra.range) {
            acornOptions.ranges = true;
        }

        if (extra.loc) {
            acornOptions.locations = true;
        }

        if (extra.ecmaFeatures.jsx) {

            // Should process jsx plugin before espree plugin.
            acornOptions.plugins = {
                jsx: true,
                espree: true
            };
        }
    }

    const program = acorn.parse(code, acornOptions);

    program.sourceType = extra.isModule ? "module" : "script";

    if (extra.comment || extra.attachComment) {
        program.comments = extra.comments;
    }

    if (extra.tokens) {
        program.tokens = extra.tokens;
    }

    /*
     * Adjust opening and closing position of program to match Esprima.
     * Acorn always starts programs at range 0 whereas Esprima starts at the
     * first AST node's start (the only real difference is when there's leading
     * whitespace or leading comments). Acorn also counts trailing whitespace
     * as part of the program whereas Esprima only counts up to the last token.
     */
    if (program.range) {
        program.range[0] = program.body.length ? program.body[0].range[0] : program.range[0];
        program.range[1] = lastToken ? lastToken.range[1] : program.range[1];
    }

    if (program.loc) {
        program.loc.start = program.body.length ? program.body[0].loc.start : program.loc.start;
        program.loc.end = lastToken ? lastToken.loc.end : program.loc.end;
    }

    return program;
}

//------------------------------------------------------------------------------
// Public
//------------------------------------------------------------------------------

exports.version = require("./package.json").version;

exports.tokenize = tokenize;

exports.parse = parse;

// Deep copy.
/* istanbul ignore next */
exports.Syntax = (function() {
    let name,
        types = {};

    if (typeof Object.create === "function") {
        types = Object.create(null);
    }

    for (name in astNodeTypes) {
        if (astNodeTypes.hasOwnProperty(name)) {
            types[name] = astNodeTypes[name];
        }
    }

    if (typeof Object.freeze === "function") {
        Object.freeze(types);
    }

    return types;
}());

/* istanbul ignore next */
exports.VisitorKeys = (function() {
    const visitorKeys = require("./lib/visitor-keys");
    let name,
        keys = {};

    if (typeof Object.create === "function") {
        keys = Object.create(null);
    }

    for (name in visitorKeys) {
        if (visitorKeys.hasOwnProperty(name)) {
            keys[name] = visitorKeys[name];
        }
    }

    if (typeof Object.freeze === "function") {
        Object.freeze(keys);
    }

    return keys;
}());
