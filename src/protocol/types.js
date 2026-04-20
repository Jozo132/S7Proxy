// @ts-check
// Core types shared across the S7Proxy Node.js layer
// This file contains only JSDoc type definitions — no runtime code.

// ─── PLC Endpoint & Target ───

/**
 * @typedef {Object} PlcEndpoint
 * @property {string} ip
 * @property {number} rack
 * @property {number} slot
 */

/**
 * @typedef {Object} FailoverConfig
 * @property {number} healthCheckIntervalMs
 * @property {number} healthCheckTimeoutMs
 * @property {number} failoverThreshold
 * @property {'auto' | 'manual'} failbackMode
 * @property {number} failbackDelayMs
 * @property {number} failbackThreshold
 * @property {'tcp' | 's7'} [healthProbeMode]
 */

/**
 * @typedef {Object} PlcTarget
 * @property {string} id
 * @property {PlcEndpoint} primary
 * @property {PlcEndpoint[]} [backups]
 * @property {number} maxConnections
 * @property {number} [keepAliveIntervalMs]
 * @property {number[]} [reconnectBackoffMs]
 * @property {number} [requestTimeoutMs]
 * @property {FailoverConfig} [failover]
 */

// ─── Session ───

/**
 * @typedef {'NEW' | 'CONNECTED' | 'COTP_PENDING' | 'COTP_CONNECTED' | 'S7_SETUP_PENDING' | 'ESTABLISHED' | 'CLOSED' | 'ERROR'} SessionState
 */

/**
 * @typedef {Object} SessionInfo
 * @property {string} id
 * @property {SessionState} state
 * @property {string} clientAddr
 * @property {number} clientPort
 * @property {string | null} targetId
 * @property {number} srcTsap
 * @property {number} dstTsap
 * @property {number} pduSize
 * @property {number} maxAmq
 * @property {number} pduCount
 * @property {number} createdAt
 * @property {number} lastActivityAt
 * @property {number} lastPduRef
 * @property {number} errorClass
 * @property {number} errorCode
 * @property {string} [errorDetail]
 */

// ─── Failover ───

/**
 * @typedef {'PRIMARY_ACTIVE' | 'FAILING_OVER' | 'BACKUP_ACTIVE' | 'TRY_NEXT_BACKUP' | 'FAILBACK'} FailoverState
 */

/**
 * @typedef {Object} EndpointHealth
 * @property {PlcEndpoint} endpoint
 * @property {boolean} healthy
 * @property {number} consecutiveFailures
 * @property {number} consecutiveSuccesses
 * @property {number} lastCheckAt
 * @property {number} latencyMs
 */

// ─── Routing ───

/**
 * @typedef {Object} RoutingRule
 * @property {string} [srcIp]
 * @property {number} [dstTsap]
 * @property {string} targetId
 * @property {number} [priority]
 */

/**
 * @typedef {Object} FilterRule
 * @property {'allow' | 'deny'} action
 * @property {string} [targetId]
 * @property {string} [srcIp]
 * @property {number} [functionCode]
 * @property {number} [area]
 * @property {number} [dbNumber]
 */

// ─── Priority Queue ───

/**
 * @typedef {'critical' | 'high' | 'normal' | 'low'} PriorityLevel
 */

/**
 * @typedef {'proxy' | 'rest' | 'daq' | 'management'} RequestSource
 */

/**
 * @typedef {Object} PriorityRequest
 * @property {string} id
 * @property {PriorityLevel} priority
 * @property {string} targetId
 * @property {Buffer} pduData
 * @property {(data: Buffer) => void} resolve
 * @property {(err: Error) => void} reject
 * @property {number} createdAt
 * @property {number} [enqueuedAt]
 * @property {number} timeoutMs
 * @property {RequestSource} source
 */

// ─── DAQ ───

/**
 * @typedef {Object} TagDefinition
 * @property {string} name
 * @property {string} area
 * @property {number} offset
 * @property {number} [dbNum]
 * @property {string} [type]
 * @property {number} [amount]
 * @property {string} target
 */

/**
 * @typedef {Object} DaqSubscription
 * @property {string} id
 * @property {string} targetId
 * @property {string[]} tags
 * @property {number} intervalMs
 * @property {number} createdAt
 * @property {boolean} active
 * @property {string} [clientId]
 */

/**
 * @typedef {Object} CachedValue
 * @property {string} tagName
 * @property {Buffer} value
 * @property {number} timestamp
 * @property {'good' | 'uncertain' | 'bad'} quality
 * @property {string} source
 */

// ─── Config ───

/**
 * @typedef {Object} WebApiConfig
 * @property {boolean} enabled
 * @property {string} host
 * @property {number} port
 * @property {{ origin: string }} [cors]
 * @property {{ type: 'none' | 'api-key' | 'jwt'; keys?: string[] }} [auth]
 * @property {{ max: number; windowMs: number }} [rateLimit]
 * @property {{ enabled: boolean; cert: string; key: string }} [tls]
 */

/**
 * @typedef {Object} DaqConfig
 * @property {number} minScanIntervalMs
 * @property {number} maxScanGroupsPerTarget
 * @property {number} maxTagsPerSubscription
 * @property {number} maxGapBytes
 * @property {boolean} cacheEnabled
 * @property {number} cacheTtlMs
 * @property {{ fairnessWindow: number; agingThresholdMs: number }} priorityQueue
 * @property {{ maxSendBufferBytes: number; maxDroppedFrames: number; dropWindowMs: number }} slowClient
 */

/**
 * @typedef {Object} LogConfig
 * @property {'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'} level
 * @property {boolean} [pretty]
 */

/**
 * @typedef {Object} MetricsConfig
 * @property {boolean} enabled
 * @property {number} [port]
 * @property {string} [path]
 */

/**
 * @typedef {Object} S7ProxyConfig
 * @property {{ ip: string; port: number }} listen
 * @property {PlcTarget[]} targets
 * @property {RoutingRule[]} routing
 * @property {FilterRule[]} filters
 * @property {FailoverConfig} failover
 * @property {WebApiConfig} webApi
 * @property {DaqConfig} daq
 * @property {LogConfig} logging
 * @property {MetricsConfig} metrics
 */

// ─── Parsed PDU ───

/**
 * @typedef {Object} ParsedPDU
 * @property {Buffer} raw
 * @property {number} messageType
 * @property {number} functionCode
 * @property {number} pduRef
 * @property {number} paramLength
 * @property {number} dataLength
 * @property {number} errorClass
 * @property {number} errorCode
 */

// ─── PLC Connection ───

/**
 * @typedef {Object} PlcConnectionInfo
 * @property {string} id
 * @property {string} targetId
 * @property {PlcEndpoint} endpoint
 * @property {'connecting' | 'cotp' | 's7_setup' | 'ready' | 'error' | 'closed'} state
 * @property {number} pduSize
 * @property {number} maxAmqCalling
 * @property {number} maxAmqCalled
 * @property {number} freeAmqSlots
 * @property {number} connectedAt
 * @property {number} lastActivityAt
 */
