// @ts-check
// Prometheus-compatible metrics

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

export class Metrics {
  /** @readonly @type {Registry} */
  registry;

  // Connection metrics
  /** @readonly @type {Gauge} */ clientConnectionsActive;
  /** @readonly @type {Counter} */ clientConnectionsTotal;
  /** @readonly @type {Gauge} */ plcConnectionsActive;
  /** @readonly @type {Counter} */ plcConnectionReconnects;

  // PDU metrics
  /** @readonly @type {Counter} */ pdusIn;
  /** @readonly @type {Counter} */ pdusOut;
  /** @readonly @type {Histogram} */ pduLatency;

  // Failover
  /** @readonly @type {Counter} */ failoverTotal;
  /** @readonly @type {Gauge} */ healthProbeResult;
  /** @readonly @type {Gauge} */ activeEndpoint;

  // Priority queue
  /** @readonly @type {Gauge} */ priorityQueueSize;
  /** @readonly @type {Histogram} */ priorityQueueWait;
  /** @readonly @type {Counter} */ priorityQueueAgedPromotions;

  // DAQ
  /** @readonly @type {Histogram} */ daqScanDuration;
  /** @readonly @type {Counter} */ daqScanTotal;
  /** @readonly @type {Counter} */ daqMissedScans;
  /** @readonly @type {Gauge} */ daqActiveScanGroups;
  /** @readonly @type {Gauge} */ daqActiveSubscriptions;
  /** @readonly @type {Gauge} */ daqTagsTotal;
  /** @readonly @type {Gauge} */ daqTagsUnique;
  /** @readonly @type {Counter} */ daqCoalescedReads;

  // REST
  /** @readonly @type {Counter} */ restRequestsTotal;
  /** @readonly @type {Counter} */ restCacheHits;
  /** @readonly @type {Histogram} */ restLatency;

  // WebSocket
  /** @readonly @type {Gauge} */ wsClientsActive;
  /** @readonly @type {Counter} */ wsDroppedFrames;
  /** @readonly @type {Counter} */ wsSlowConsumerDisconnects;

  // PLC connection detail
  /** @readonly @type {Gauge} */ plcAmqSlotsFree;
  /** @readonly @type {Gauge} */ plcAmqSlotsTotal;
  /** @readonly @type {Gauge} */ plcConnectionUptime;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.clientConnectionsActive = new Gauge({
      name: 's7proxy_client_connections_active',
      help: 'Number of active S7 client connections',
      registers: [this.registry],
    });

    this.clientConnectionsTotal = new Counter({
      name: 's7proxy_client_connections_total',
      help: 'Total S7 client connections',
      registers: [this.registry],
    });

    this.plcConnectionsActive = new Gauge({
      name: 's7proxy_plc_connections_active',
      help: 'Active persistent PLC connections',
      labelNames: ['target'],
      registers: [this.registry],
    });

    this.plcConnectionReconnects = new Counter({
      name: 's7proxy_plc_connection_reconnects_total',
      help: 'PLC connection reconnect attempts',
      labelNames: ['target'],
      registers: [this.registry],
    });

    this.pdusIn = new Counter({
      name: 's7proxy_pdus_in_total',
      help: 'Total PDUs received',
      labelNames: ['direction'],
      registers: [this.registry],
    });

    this.pdusOut = new Counter({
      name: 's7proxy_pdus_out_total',
      help: 'Total PDUs sent',
      labelNames: ['direction'],
      registers: [this.registry],
    });

    this.pduLatency = new Histogram({
      name: 's7proxy_pdu_latency_ms',
      help: 'PDU round-trip latency in milliseconds',
      labelNames: ['target'],
      buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
      registers: [this.registry],
    });

    this.failoverTotal = new Counter({
      name: 's7proxy_failover_total',
      help: 'Total failover events',
      labelNames: ['target', 'direction'],
      registers: [this.registry],
    });

    this.healthProbeResult = new Gauge({
      name: 's7proxy_health_probe_result',
      help: 'Health probe result (1=healthy, 0=unhealthy)',
      labelNames: ['target', 'endpoint'],
      registers: [this.registry],
    });

    this.activeEndpoint = new Gauge({
      name: 's7proxy_active_endpoint',
      help: 'Active endpoint index (0=primary, 1+=backup)',
      labelNames: ['target'],
      registers: [this.registry],
    });

    this.priorityQueueSize = new Gauge({
      name: 's7proxy_priority_queue_size',
      help: 'Current priority queue size',
      labelNames: ['target', 'priority'],
      registers: [this.registry],
    });

    this.priorityQueueWait = new Histogram({
      name: 's7proxy_priority_queue_wait_ms',
      help: 'Time requests wait in priority queue',
      labelNames: ['target', 'priority'],
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000],
      registers: [this.registry],
    });

    this.priorityQueueAgedPromotions = new Counter({
      name: 's7proxy_priority_queue_aged_promotions_total',
      help: 'Requests promoted due to aging',
      labelNames: ['target'],
      registers: [this.registry],
    });

    this.daqScanDuration = new Histogram({
      name: 's7proxy_daq_scan_duration_ms',
      help: 'DAQ scan cycle duration',
      labelNames: ['target', 'group'],
      buckets: [1, 5, 10, 25, 50, 100, 250, 500],
      registers: [this.registry],
    });

    this.daqScanTotal = new Counter({
      name: 's7proxy_daq_scan_total',
      help: 'Total DAQ scans executed',
      labelNames: ['target', 'group'],
      registers: [this.registry],
    });

    this.daqMissedScans = new Counter({
      name: 's7proxy_daq_missed_scans',
      help: 'DAQ scans that missed their deadline',
      labelNames: ['target', 'group'],
      registers: [this.registry],
    });

    this.daqActiveScanGroups = new Gauge({
      name: 's7proxy_daq_active_scan_groups',
      help: 'Active scan groups',
      labelNames: ['target'],
      registers: [this.registry],
    });

    this.daqActiveSubscriptions = new Gauge({
      name: 's7proxy_daq_active_subscriptions',
      help: 'Active DAQ subscriptions',
      registers: [this.registry],
    });

    this.daqTagsTotal = new Gauge({
      name: 's7proxy_daq_tags_total',
      help: 'Total subscribed tags (before dedup)',
      labelNames: ['target'],
      registers: [this.registry],
    });

    this.daqTagsUnique = new Gauge({
      name: 's7proxy_daq_tags_unique',
      help: 'Unique tags after dedup',
      labelNames: ['target'],
      registers: [this.registry],
    });

    this.daqCoalescedReads = new Counter({
      name: 's7proxy_daq_coalesced_reads',
      help: 'Number of coalesced read operations',
      labelNames: ['target'],
      registers: [this.registry],
    });

    this.restRequestsTotal = new Counter({
      name: 's7proxy_rest_requests_total',
      help: 'REST API requests',
      labelNames: ['target', 'method'],
      registers: [this.registry],
    });

    this.restCacheHits = new Counter({
      name: 's7proxy_rest_cache_hits_total',
      help: 'REST requests served from cache',
      labelNames: ['target'],
      registers: [this.registry],
    });

    this.restLatency = new Histogram({
      name: 's7proxy_rest_latency_ms',
      help: 'REST request latency',
      labelNames: ['target'],
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
      registers: [this.registry],
    });

    this.wsClientsActive = new Gauge({
      name: 's7proxy_ws_clients_active',
      help: 'Active WebSocket DAQ clients',
      registers: [this.registry],
    });

    this.wsDroppedFrames = new Counter({
      name: 's7proxy_ws_dropped_frames_total',
      help: 'Frames dropped due to slow consumer',
      labelNames: ['client'],
      registers: [this.registry],
    });

    this.wsSlowConsumerDisconnects = new Counter({
      name: 's7proxy_ws_disconnects_slow_consumer_total',
      help: 'Clients disconnected for being too slow',
      registers: [this.registry],
    });

    this.plcAmqSlotsFree = new Gauge({
      name: 's7proxy_plc_amq_slots_free',
      help: 'Free AMQ slots on PLC connection',
      labelNames: ['target', 'conn'],
      registers: [this.registry],
    });

    this.plcAmqSlotsTotal = new Gauge({
      name: 's7proxy_plc_amq_slots_total',
      help: 'Total AMQ slots on PLC connection',
      labelNames: ['target', 'conn'],
      registers: [this.registry],
    });

    this.plcConnectionUptime = new Gauge({
      name: 's7proxy_plc_connection_uptime_ms',
      help: 'PLC connection uptime in milliseconds',
      labelNames: ['target', 'conn'],
      registers: [this.registry],
    });
  }
}
