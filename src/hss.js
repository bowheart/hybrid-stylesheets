/*
	Hybrid Stylesheets (hss)
	Another library by Joshua Claunch -- https://github.com/bowheart
*/

'use strict'

const fs = require('fs')

const quoteRegex = /['"`]/
const whitespaceRegex = /\s+/

const COMMENT = 'COMMENT'
const STRING = 'STRING'
const WHITESPACE = 'WHITESPACE'

// Abstract class
class Reader {
	constructor(filename, input, line) {
		this.filename = filename
		this.input = input
		this.line = line || 1
		this.context = new RootContext(this)
	}
	
	error(msg) {
		throw new SyntaxError('Hss Error in ' + this.filename + ' on line ' + this.line + '\n' + msg)
	}
	
	next() {
		let next = this.input[0]
		this.input = this.input.slice(1)
		
		if (next === '\n') this.line++
		return next
	}
	
	peek(length) {
		return length ? this.input.slice(0, length) : this.input[0]
	}
	
	lineComment() {
		let content = ''
		let next
		while ((next = this.peek()) && next !== '\n') {
			this.next() // discard
			content += next
		}
		this.context.add(content, COMMENT)
	}
	blockComment() {
		// Get the '/*'
		let content = this.next() + this.next()
		let next
		
		while ((next = this.peek(2)) && next !== '*/') {
			content += this.next()
		}
		// Get the '*/'
		content += this.next() + this.next()
		
		this.context.add(content, COMMENT)
	}
	COMMENT() {
		let next = this.peek(2)
		if (next === '//') return this.lineComment()
		if (next === '/*') return this.blockComment()
		this.context.add(this.next())
	}
	
	STRING() {
		let type = this.next() // double or single quote or backtick (multi-line)
		let next
		let str = type
		
		while ((next = this.peek()) && next !== type) {
			switch (next) {
				case '\\':
					this.next() // strip the escape character
					str += this.next() // stick whatever comes next on there
					continue
				case '\n':
					if (type !== '`') this.error('Unexpected multi-line string')
				default:
					str += this.next()
			}
		}
		if (next !== type) this.error('Unexpected end of file')
		str += this.next() // remove the closing quote
		this.context.add(str, STRING)
	}
	
	WHITESPACE() {
		this.context.add(this.next(), WHITESPACE)
	}
}


// Contexts can be nested indefinitely -- << css then [javascript + 'then' + << more css [etc] >>] >>
class Context {
	constructor(transpiler, parentContext) {
		this.transpiler = transpiler
		this.parentContext = parentContext
		this.content = ''
		this.startingLine = transpiler.line // take a snapshot of the current line
	}
	
	add(str, type) {
		if (type && this[type]) return this[type](str) // allow for custom handlers based on type
		if (this.beforeAdd) this.beforeAdd(str)
		this.content += str
	}
	
	childContextStart() {
		if (this.transpiler.peek(2) !== '<<') return false
		
		// Discard the '<<'
		this.transpiler.next()
		this.transpiler.next()
		return true
	}
	contextEnd() {
		return false // e.g. the root context can't end
	}
	childContextEnd() {
		let contextContent = this.childContext.toString()
		this.childContext = null
		this.saveChildContent(contextContent)
		return this
	}
	saveChildContent(content) {
		this.add(content)
	}
	newChildContext() {}
	
	toString() { return this.content }
	get endDelimiter() { return '' }
	get name() { return '' }
}

class RootContext extends Context {
	saveChildContent(content) {
		this.add('sheath.css.evaluate(' + content + ')')
	}
	newChildContext() {
		return this.childContext = new HssContext(this.transpiler, this)
	}
}

class ChildContext extends Context {
	COMMENT() {} // discard comments
	WHITESPACE() {
		if (this.content.slice(-1) !== ' ') this.add(' ')
	}
}

class HssContext extends ChildContext {
	childContextStart() {
		if (this.transpiler.peek() !== '[') return false
		
		// Discard the '['
		this.transpiler.next()
		return true
	}
	contextEnd() {
		if (this.transpiler.peek(2) !== this.endDelimiter) return false
		
		// Discard the end delimiter
		for (let i = 0; i < this.endDelimiter.length; i++) this.transpiler.next()
		
		return true
	}
	
	newChildContext() {
		return this.childContext = new JsContext(this.transpiler, this)
	}
	
	STRING(str) {
		if (str[0] !== "'") return this.add(str)
		
		str = str.slice(1, -1) // strip the quotes
		str = str.replace(/'/g, "\\\\\\'")
		str = "\\'" + str + "\\'"
		this.add(str)
	}
	
	toString() {
		return "'" + this.content.trim() + "'"
	}
	get endDelimiter() { return '>>' }
	get name() { return 'Hss expression' }
}

class JsContext extends ChildContext {
	constructor(transpiler, parentContext) {
		super(transpiler, parentContext)
		this.ignoreCount = 0
	}
	
	beforeAdd(str) {
		if (str  === '[') this.ignoreCount++
	}
	
	contextEnd() {
		if (this.transpiler.peek() !== this.endDelimiter) return false
		if (this.ignoreCount) {
			this.add(this.transpiler.next())
			this.ignoreCount--
			return false
		}
		
		// Discard the end delimiter
		for (let i = 0; i < this.endDelimiter.length; i++) this.transpiler.next()
		
		return true
	}
	
	newChildContext() {
		return this.childContext = new HssContext(this.transpiler, this)
	}
	
	toString() {
		return "' + sheath.css.jsExpr(" + this.content + ") + '"
	}
	get endDelimiter() { return ']' }
	get name() { return 'JavaScript expression' }
}

class Transpiler extends Reader {
	constructor(filename, input) {
		super(filename, input)
	}
	
	transpile() {
		let next
		while (next = this.peek()) {
			if (quoteRegex.test(next)) this.STRING()
			else if (next === '/') this.COMMENT()
			else if (whitespaceRegex.test(next)) this.WHITESPACE()
			else if (this.context.childContextStart()) this.newContext()
			else if (this.context.contextEnd()) this.endContext()
			else this.context.add(this.next())
		}
		if (!(this.context instanceof RootContext)) {
			this.error('Unexpected end of file. It looks like you forgot the closing "' + this.context.endDelimiter + '" of the ' + this.context.name + ' beginning on line ' + this.context.startingLine + '.')
		}
		return this.context.toString()
	}
	
	newContext() {
		this.context = this.context.newChildContext()
	}
	
	endContext() {
		this.context = this.context.parentContext.childContextEnd()
	}
}


function transpilerFactory(filename, callback) {
	fs.readFile(filename, (err, contents) => {
		if (err) throw err
		
		let input = contents.toString()
		let transpiler = new Transpiler(filename, input)
		let result = transpiler.transpile()
		callback(result)
	})
}

module.exports = {
	/*
		hss.transpile()
		Turn all << hss >> snippets in a file into valid JavaScript.
		Each root-level snippet will be wrapped in a sheath.css.module() call.
	*/
	transpile: transpilerFactory
}
