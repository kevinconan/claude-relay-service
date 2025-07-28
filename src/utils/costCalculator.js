const pricingService = require('../services/pricingService');

// Claude模型价格配置 (USD per 1M tokens) - 备用定价
const MODEL_PRICING = {
  // Claude Opus 4
  'claude-opus-4-20250514': {
    input: 15.00,
    output: 75.00,
    cacheWrite5m: 18.75,    // 5分钟缓存
    cacheWrite1h: 30.00,    // 1小时缓存
    cacheRead: 1.50
  },
  
  // Claude Sonnet 4
  'claude-sonnet-4-20250514': {
    input: 3.00,
    output: 15.00,
    cacheWrite5m: 3.75,     // 5分钟缓存
    cacheWrite1h: 6.00,     // 1小时缓存
    cacheRead: 0.30
  },
  
  // Claude 3.5 Sonnet (3.7)
  'claude-3-5-sonnet-20241022': {
    input: 3.00,
    output: 15.00,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6.00,
    cacheRead: 0.30
  },
  
  // Claude 3.5 Haiku
  'claude-3-5-haiku-20241022': {
    input: 0.80,            // 修正为官方价格
    output: 4.00,           // 修正为官方价格
    cacheWrite5m: 1.00,
    cacheWrite1h: 1.60,
    cacheRead: 0.08
  },
  
  // Claude 3 Opus
  'claude-3-opus-20240229': {
    input: 15.00,
    output: 75.00,
    cacheWrite5m: 18.75,
    cacheWrite1h: 30.00,
    cacheRead: 1.50
  },
  
  // Claude 3 Sonnet
  'claude-3-sonnet-20240229': {
    input: 3.00,
    output: 15.00,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6.00,
    cacheRead: 0.30
  },
  
  // Claude 3 Haiku
  'claude-3-haiku-20240307': {
    input: 0.25,
    output: 1.25,
    cacheWrite5m: 0.30,
    cacheWrite1h: 0.50,
    cacheRead: 0.03
  },
  
  // 默认定价（用于未知模型）
  'unknown': {
    input: 3.00,
    output: 15.00,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6.00,
    cacheRead: 0.30
  }
};

class CostCalculator {
  
  /**
   * 解析缓存TTL类型
   * @param {number|string} ttl - TTL值（秒）
   * @returns {string} '5m' 或 '1h'
   */
  static parseCacheTTL(ttl) {
    if (!ttl) return '5m'; // 默认5分钟
    
    const ttlSeconds = typeof ttl === 'string' ? parseInt(ttl) : ttl;
    if (isNaN(ttlSeconds)) return '5m';
    
    // 300秒(5分钟)以下按5分钟计费，超过按1小时计费
    return ttlSeconds <= 300 ? '5m' : '1h';
  }

  /**
   * 计算单次请求的费用
   * @param {Object} usage - 使用量数据
   * @param {number} usage.input_tokens - 输入token数量
   * @param {number} usage.output_tokens - 输出token数量
   * @param {number} usage.cache_creation_input_tokens - 缓存创建token数量
   * @param {number} usage.cache_read_input_tokens - 缓存读取token数量
   * @param {string} usage.cache_ttl - 缓存TTL类型 ('5m' 或 '1h')
   * @param {string} model - 模型名称
   * @returns {Object} 费用详情
   */
  static calculateCost(usage, model = 'unknown') {
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheCreateTokens = usage.cache_creation_input_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;
    const cacheTTL = usage.cache_ttl || '5m'; // 默认5分钟缓存
    
    // 优先使用动态价格服务
    const pricingData = pricingService.getModelPricing(model);
    let pricing;
    let usingDynamicPricing = false;
    
    if (pricingData) {
      // 转换动态价格格式为内部格式
      // 注意：动态价格数据可能需要更新以支持TTL分级
      pricing = {
        input: (pricingData.input_cost_per_token || 0) * 1000000,
        output: (pricingData.output_cost_per_token || 0) * 1000000,
        cacheWrite5m: (pricingData.cache_creation_input_token_cost || 0) * 1000000,
        cacheWrite1h: (pricingData.cache_creation_input_token_cost_1h || pricingData.cache_creation_input_token_cost * 1.6 || 0) * 1000000,
        cacheRead: (pricingData.cache_read_input_token_cost || 0) * 1000000
      };
      usingDynamicPricing = true;
    } else {
      // 回退到静态价格
      const staticPricing = MODEL_PRICING[model] || MODEL_PRICING['unknown'];
      pricing = {
        input: staticPricing.input,
        output: staticPricing.output,
        cacheWrite5m: staticPricing.cacheWrite5m || staticPricing.cacheWrite || staticPricing.input * 1.25,
        cacheWrite1h: staticPricing.cacheWrite1h || staticPricing.cacheWrite || staticPricing.input * 2,
        cacheRead: staticPricing.cacheRead
      };
    }
    
    // 根据TTL选择正确的缓存创建价格
    const cacheWritePrice = cacheTTL === '1h' ? pricing.cacheWrite1h : pricing.cacheWrite5m;
    
    // 计算各类型token的费用 (USD)
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    const cacheWriteCost = (cacheCreateTokens / 1000000) * cacheWritePrice;
    const cacheReadCost = (cacheReadTokens / 1000000) * pricing.cacheRead;
    
    const totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;
    
    return {
      model,
      pricing,
      usingDynamicPricing,
      cacheTTL,
      usage: {
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        totalTokens: inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
      },
      costs: {
        input: inputCost,
        output: outputCost,
        cacheWrite: cacheWriteCost,
        cacheRead: cacheReadCost,
        total: totalCost
      },
      // 格式化的费用字符串
      formatted: {
        input: this.formatCost(inputCost),
        output: this.formatCost(outputCost),
        cacheWrite: this.formatCost(cacheWriteCost),
        cacheRead: this.formatCost(cacheReadCost),
        total: this.formatCost(totalCost)
      }
    };
  }
  
  /**
   * 计算聚合使用量的费用
   * @param {Object} aggregatedUsage - 聚合使用量数据
   * @param {string} model - 模型名称
   * @returns {Object} 费用详情
   */
  static calculateAggregatedCost(aggregatedUsage, model = 'unknown') {
    const usage = {
      input_tokens: aggregatedUsage.inputTokens || aggregatedUsage.totalInputTokens || 0,
      output_tokens: aggregatedUsage.outputTokens || aggregatedUsage.totalOutputTokens || 0,
      cache_creation_input_tokens: aggregatedUsage.cacheCreateTokens || aggregatedUsage.totalCacheCreateTokens || 0,
      cache_read_input_tokens: aggregatedUsage.cacheReadTokens || aggregatedUsage.totalCacheReadTokens || 0
    };
    
    return this.calculateCost(usage, model);
  }
  
  /**
   * 获取模型定价信息
   * @param {string} model - 模型名称
   * @returns {Object} 定价信息
   */
  static getModelPricing(model = 'unknown') {
    return MODEL_PRICING[model] || MODEL_PRICING['unknown'];
  }
  
  /**
   * 获取所有支持的模型和定价
   * @returns {Object} 所有模型定价
   */
  static getAllModelPricing() {
    return { ...MODEL_PRICING };
  }
  
  /**
   * 验证模型是否支持
   * @param {string} model - 模型名称
   * @returns {boolean} 是否支持
   */
  static isModelSupported(model) {
    return !!MODEL_PRICING[model];
  }
  
  /**
   * 格式化费用显示
   * @param {number} cost - 费用金额
   * @param {number} decimals - 小数位数
   * @returns {string} 格式化的费用字符串
   */
  static formatCost(cost, decimals = 6) {
    if (cost >= 1) {
      return `$${cost.toFixed(2)}`;
    } else if (cost >= 0.001) {
      return `$${cost.toFixed(4)}`;
    } else {
      return `$${cost.toFixed(decimals)}`;
    }
  }
  
  /**
   * 计算费用节省（使用缓存的节省）
   * @param {Object} usage - 使用量数据
   * @param {string} model - 模型名称
   * @returns {Object} 节省信息
   */
  static calculateCacheSavings(usage, model = 'unknown') {
    const pricing = this.getModelPricing(model);
    const cacheReadTokens = usage.cache_read_input_tokens || 0;
    
    // 如果这些token不使用缓存，需要按正常input价格计费
    const normalCost = (cacheReadTokens / 1000000) * pricing.input;
    const cacheCost = (cacheReadTokens / 1000000) * pricing.cacheRead;
    const savings = normalCost - cacheCost;
    const savingsPercentage = normalCost > 0 ? (savings / normalCost) * 100 : 0;
    
    return {
      normalCost,
      cacheCost,
      savings,
      savingsPercentage,
      formatted: {
        normalCost: this.formatCost(normalCost),
        cacheCost: this.formatCost(cacheCost),
        savings: this.formatCost(savings),
        savingsPercentage: `${savingsPercentage.toFixed(1)}%`
      }
    };
  }
}

module.exports = CostCalculator;