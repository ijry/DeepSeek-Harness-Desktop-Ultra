import { ERROR_CODES } from '../shared/protocol.js'

const ALLOWED_SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
  'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems',
])

function error(code, message) {
  return Object.assign(new Error(message), { code })
}

function validateSchemaDefinition(schema, depth = 0) {
  if (depth > 12 || schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw error('invalid_input', 'command schema is invalid')
  }
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) throw error('invalid_input', `unsupported schema keyword ${key}`)
  }
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) {
    throw error('invalid_input', 'schema.type is invalid')
  }
  if (schema.type === 'object') {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      throw error('invalid_input', 'object properties are required')
    }
    if (schema.additionalProperties !== false) throw error('invalid_input', 'object schema must be closed')
    for (const child of Object.values(schema.properties)) validateSchemaDefinition(child, depth + 1)
    if (schema.required !== undefined && (!Array.isArray(schema.required)
        || schema.required.some(key => typeof key !== 'string' || !(key in schema.properties)))) {
      throw error('invalid_input', 'schema.required is invalid')
    }
  }
  if (schema.type === 'array') {
    if (!schema.items) throw error('invalid_input', 'array items are required')
    validateSchemaDefinition(schema.items, depth + 1)
  }
}

function actualType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function validateValue(value, schema, at = 'data') {
  const type = actualType(value)
  const matches = schema.type === type || (schema.type === 'number' && type === 'integer')
  if (!matches) throw error('invalid_input', `${at} must be ${schema.type}`)
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) {
    throw error('invalid_input', `${at} is not an allowed value`)
  }
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) throw error('invalid_input', `${at}.${key} is required`)
    }
    for (const [key, child] of Object.entries(value)) {
      if (!(key in schema.properties)) throw error('invalid_input', `${at}.${key} is not allowed`)
      validateValue(child, schema.properties[key], `${at}.${key}`)
    }
  } else if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw error('invalid_input', `${at} is too short`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw error('invalid_input', `${at} is too long`)
    value.forEach((item, index) => validateValue(item, schema.items, `${at}[${index}]`))
  } else if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw error('invalid_input', `${at} is too short`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw error('invalid_input', `${at} is too long`)
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) throw error('invalid_input', `${at} is too small`)
    if (schema.maximum !== undefined && value > schema.maximum) throw error('invalid_input', `${at} is too large`)
  }
}

export function normalizeCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw error('invalid_input', 'catalog must be an object')
  }
  if (typeof catalog.title !== 'string' || catalog.title.length === 0 || catalog.title.length > 128) {
    throw error('invalid_input', 'catalog.title is invalid')
  }
  if (!Array.isArray(catalog.commands) || catalog.commands.length > 512) {
    throw error('invalid_input', 'catalog.commands is invalid')
  }
  const names = new Set()
  for (const command of catalog.commands) {
    if (!command || typeof command !== 'object'
        || typeof command.name !== 'string' || command.name.length === 0 || command.name.length > 128
        || !['read', 'write'].includes(command.effect)
        || !['none', 'confirm', 'danger'].includes(command.confirmation)) {
      throw error('invalid_input', 'catalog command is invalid')
    }
    if (names.has(command.name)) throw error('invalid_input', 'duplicate command name')
    names.add(command.name)
    validateSchemaDefinition(command.input)
  }
  return structuredClone(catalog)
}

export function commandMap(catalog) {
  return new Map(catalog.commands.map(command => [command.name, command]))
}

export function validateCommandData(command, data) {
  validateValue(data, command.input)
}

export function safeError(reason) {
  const code = ERROR_CODES.includes(reason?.code) ? reason.code : 'internal'
  const message = code === 'internal' ? '插件请求失败' : String(reason?.message || code).slice(0, 1024)
  return { code, message }
}

export { error as sourceError }
