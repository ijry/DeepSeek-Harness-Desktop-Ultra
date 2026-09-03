/**
 * Self-contained replacements for the @deepseek-ai runtime imports a host
 * plugin normally takes from SDK packages (dsh-home-paths, dsh-tools'
 * defineTool). A published dsh plugin must never resolve @deepseek-ai/*
 * packages from the profile's node_modules at runtime (an npm-mirror copy
 * shadows the CLI-internal build and can break the agent loop), so this file
 * re-implements the exact behaviors we rely on:
 *
 * - dshHomePath() mirrors join(resolve(DSH_HOME ?? ~/.dsh), ...segments)
 * - defineTool() compiles our author-facing parameter specs into the same raw
 *   JSON-Schema subset the tool registry expects (object/properties/required/
 *   additionalProperties/scalars; `json` compiles to an annotation-only
 *   schema) and pre-validates model arguments.
 *
 * @module dsh-plugin-taskboard/host/sdk
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The DSH user home (DSH_HOME overrides ~/.dsh). */
export function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
  return join(home, ...segments)
}

/** Compile one author-facing value spec into the raw schema subset. */
function compileValue(spec) {
  const node = {}
  if (typeof spec.description === 'string' && spec.description.length > 0) node.description = spec.description
  if (spec.type === undefined || spec.type === 'json') return node
  if (spec.type === 'object') {
    node.type = 'object'
    node.additionalProperties = spec.additionalProperties
    if (spec.properties !== undefined) {
      const { properties, required } = compilePropertyMap(spec.properties)
      node.properties = properties
      if (required !== undefined) node.required = required
    }
    return node
  }
  if (spec.type === 'array') {
    node.type = 'array'
    if (spec.items !== undefined) node.items = compileValue(spec.items)
    return node
  }
  node.type = spec.type
  if (spec.enum !== undefined) node.enum = [...spec.enum]
  return node
}

/** Compile a property map into properties + required list. */
function compilePropertyMap(properties) {
  const out = {}
  const required = []
  for (const [name, entry] of Object.entries(properties)) {
    const { required: isRequired, ...valueSpec } = entry
    out[name] = compileValue(valueSpec)
    if (isRequired === true) required.push(name)
  }
  return required.length > 0 ? { properties: out, required } : { properties: out }
}

/** Whether a JS value matches a raw-subset scalar type. */
function matchesScalarType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

/** Validate a value against a compiled schema node; returns violations. */
function validateValue(schema, value, path) {
  if (typeof schema.type !== 'string' || schema.type.length === 0) return []
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [`${path} must be an object`]
    }
    const violations = []
    for (const key of schema.required ?? []) {
      if (!(key in value)) violations.push(`${path}.${key} is required`)
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(value)) {
        if (!known.has(key)) violations.push(`${path}.${key} is not a declared property`)
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) violations.push(...validateValue(child, value[key], `${path}.${key}`))
    }
    return violations
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    const violations = []
    const items = schema.items
    if (items !== undefined) {
      value.forEach((item, index) => violations.push(...validateValue(items, item, `${path}[${index}]`)))
    }
    return violations
  }
  if (!matchesScalarType(value, schema.type)) return [`${path} must be ${schema.type}`]
  if (schema.enum !== undefined && !schema.enum.some((v) => v === value)) {
    return [`${path} must be one of ${schema.enum.map(String).join(', ')}`]
  }
  return []
}

/**
 * Define a first-party tool: compile the parameter spec, pre-validate
 * arguments, and pass through the execution. Produces the registry shape
 * ({ name, description, parameters, output: { schema, render }, execute }).
 */
export function defineTool(options) {
  const parameters = { type: 'object', properties: {} }
  const compiled = compilePropertyMap(options.parameters ?? {})
  parameters.properties = compiled.properties
  if (compiled.required !== undefined) parameters.required = compiled.required
  const userExecute = options.execute
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      // The SDK compiles a `json` root to an annotation-only schema.
      schema: {},
      render(args, value) {
        return options.output.render(args, value)
      },
    },
    async execute(args, exec) {
      const violations = validateValue(parameters, args, 'arguments')
      if (violations.length > 0) {
        throw new Error(`Error: invalid arguments: ${violations.join('; ')}`)
      }
      return userExecute(args, exec)
    },
  }
}
