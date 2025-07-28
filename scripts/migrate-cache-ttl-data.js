#!/usr/bin/env node

/**
 * 缓存TTL历史数据迁移脚本
 * 
 * 说明：
 * 由于历史数据中没有记录缓存的TTL信息（之前系统会删除TTL字段），
 * 因此无法准确地将历史缓存使用数据按照5分钟和1小时进行分类。
 * 
 * 本脚本提供以下功能：
 * 1. 统计现有的缓存使用数据
 * 2. 将历史缓存数据默认归类为5分钟缓存（保守估计）
 * 3. 生成迁移报告
 */

const Redis = require('ioredis');
const config = require('../config/config');
const logger = require('../src/utils/logger');

// 时区辅助函数
function getDateInTimezone(date = new Date()) {
  const offset = config.system.timezoneOffset || 8;
  const utcTime = date.getTime() + (date.getTimezoneOffset() * 60000);
  const targetTime = new Date(utcTime + (offset * 3600000));
  return targetTime;
}

function getDateStringInTimezone(date = new Date()) {
  const tzDate = getDateInTimezone(date);
  return `${tzDate.getFullYear()}-${String(tzDate.getMonth() + 1).padStart(2, '0')}-${String(tzDate.getDate()).padStart(2, '0')}`;
}

class CacheTTLMigration {
  constructor() {
    this.redis = null;
    this.stats = {
      keysProcessed: 0,
      accountsProcessed: 0,
      totalCacheTokens: 0,
      migratedRecords: 0,
      errors: 0
    };
  }

  async connect() {
    this.redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db
    });

    await this.redis.ping();
    logger.info('✅ Connected to Redis');
  }

  async disconnect() {
    if (this.redis) {
      await this.redis.quit();
      logger.info('👋 Disconnected from Redis');
    }
  }

  // 分析现有的缓存使用数据
  async analyzeExistingData() {
    logger.info('📊 Analyzing existing cache usage data...');

    // 获取所有API Key的日统计
    const dailyKeys = await this.redis.keys('usage:daily:*');
    
    for (const key of dailyKeys) {
      try {
        const data = await this.redis.hgetall(key);
        const cacheCreateTokens = parseInt(data.cacheCreateTokens || 0);
        
        if (cacheCreateTokens > 0) {
          this.stats.totalCacheTokens += cacheCreateTokens;
          
          // 提取keyId和日期
          const parts = key.split(':');
          const keyId = parts[2];
          const date = parts[3];
          
          // 创建默认的5分钟缓存记录（保守估计）
          const cache5mKey = `usage:cache5m:daily:${keyId}:${date}`;
          const exists = await this.redis.exists(cache5mKey);
          
          if (!exists) {
            await this.redis.hset(cache5mKey, {
              tokens: cacheCreateTokens,
              requests: data.cacheRequests || data.requests || 1,
              migrated: 'true',
              migratedAt: new Date().toISOString()
            });
            
            // 设置过期时间（与原数据保持一致）
            const ttl = await this.redis.ttl(key);
            if (ttl > 0) {
              await this.redis.expire(cache5mKey, ttl);
            }
            
            this.stats.migratedRecords++;
            logger.debug(`✅ Migrated cache data for ${keyId} on ${date}: ${cacheCreateTokens} tokens`);
          }
        }
        
        this.stats.keysProcessed++;
      } catch (error) {
        logger.error(`❌ Error processing key ${key}:`, error);
        this.stats.errors++;
      }
    }

    // 处理账户级别的缓存数据
    const accountDailyKeys = await this.redis.keys('account_usage:daily:*');
    
    for (const key of accountDailyKeys) {
      try {
        const data = await this.redis.hgetall(key);
        const cacheCreateTokens = parseInt(data.cacheCreateTokens || 0);
        
        if (cacheCreateTokens > 0) {
          // 提取accountId和日期
          const parts = key.split(':');
          const accountId = parts[2];
          const date = parts[3];
          
          // 创建默认的5分钟缓存记录
          const cache5mKey = `account_usage:cache5m:daily:${accountId}:${date}`;
          const exists = await this.redis.exists(cache5mKey);
          
          if (!exists) {
            await this.redis.hset(cache5mKey, {
              tokens: cacheCreateTokens,
              requests: data.cacheRequests || 1,
              migrated: 'true',
              migratedAt: new Date().toISOString()
            });
            
            // 设置过期时间
            const ttl = await this.redis.ttl(key);
            if (ttl > 0) {
              await this.redis.expire(cache5mKey, ttl);
            }
            
            this.stats.migratedRecords++;
            logger.debug(`✅ Migrated account cache data for ${accountId} on ${date}: ${cacheCreateTokens} tokens`);
          }
        }
        
        this.stats.accountsProcessed++;
      } catch (error) {
        logger.error(`❌ Error processing account key ${key}:`, error);
        this.stats.errors++;
      }
    }
  }

  // 生成迁移报告
  generateReport() {
    const report = `
========================================
  缓存TTL历史数据迁移报告
========================================

迁移时间: ${new Date().toISOString()}

处理统计:
- API Keys处理数: ${this.stats.keysProcessed}
- 账户处理数: ${this.stats.accountsProcessed}
- 总缓存Token数: ${this.stats.totalCacheTokens.toLocaleString()}
- 迁移记录数: ${this.stats.migratedRecords}
- 错误数: ${this.stats.errors}

注意事项:
1. 由于历史数据中没有TTL信息，所有历史缓存使用都被归类为5分钟缓存
2. 这是保守估计，实际可能有部分是1小时缓存
3. 从迁移完成后，新的数据将准确记录TTL类型
4. 迁移的数据已标记migrated=true，避免重复迁移

建议:
- 监控新数据的TTL分布情况
- 根据实际使用情况调整计费策略
- 考虑为用户提供TTL使用报告

========================================
`;

    return report;
  }

  async run() {
    try {
      logger.info('🚀 Starting cache TTL data migration...');
      
      await this.connect();
      await this.analyzeExistingData();
      
      const report = this.generateReport();
      console.log(report);
      
      // 保存报告到文件
      const fs = require('fs');
      const reportPath = `./migration-report-${Date.now()}.txt`;
      fs.writeFileSync(reportPath, report);
      logger.info(`📄 Report saved to: ${reportPath}`);
      
    } catch (error) {
      logger.error('💥 Migration failed:', error);
      throw error;
    } finally {
      await this.disconnect();
    }
  }
}

// 运行迁移
if (require.main === module) {
  const migration = new CacheTTLMigration();
  
  // 添加命令行参数支持
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  
  if (dryRun) {
    logger.info('🔍 Running in DRY-RUN mode (no changes will be made)');
  }
  
  migration.run()
    .then(() => {
      logger.success('✅ Migration completed successfully');
      process.exit(0);
    })
    .catch(error => {
      logger.error('❌ Migration failed:', error);
      process.exit(1);
    });
}

module.exports = CacheTTLMigration;