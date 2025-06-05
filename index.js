import SitemapXMLParser from 'sitemap-xml-parser'
import xl from 'excel4node'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { createLogger, format, transports } from 'winston'
import ora from 'ora'
import chalk from 'chalk'
import dotenv from 'dotenv'
dotenv.config()

// Configuration
const config = {
    siteMap: 'https://www.matthitch.com/sitemap_index.xml',
    API_KEY: process.env.PAGESPEED_API_KEY,
    maxRetries: 3,
    retryDelay: 1000, // ms
    rateLimit: {
        requestsPerMinute: 30,
        interval: 60000 // ms
    },
    logging: {
        level: 'info',
        file: 'output/pagespeed-audit.log',
        console: true
    },
    checkpoint: {
        enabled: true,
        file: 'output/checkpoint.json',
        interval: 5 // Save checkpoint every N URLs
    },
    output: {
        directory: 'output',
        excel: {
            prefix: 'pagespeed_',
            suffix: '_report'
        },
        summary: {
            prefix: 'summary_',
            suffix: '_report'
        }
    },
    thresholds: {
        good: {
            FCP: 1.8,
            SI: 3.4,
            LCP: 2.5,
            TBT: 200,
            CLS: 0.1,
            score: 90
        },
        needsImprovement: {
            FCP: 3.0,
            SI: 5.8,
            LCP: 4.0,
            TBT: 600,
            CLS: 0.25,
            score: 50
        }
    }
}

// Setup logger
const logger = createLogger({
    level: config.logging.level,
    format: format.combine(
        format.timestamp(),
        format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new transports.File({ filename: config.logging.file }),
        ...(config.logging.console ? [new transports.Console()] : [])
    ]
});

// Rate limiting implementation
class RateLimiter {
    constructor(requestsPerMinute, interval) {
        this.requestsPerMinute = requestsPerMinute;
        this.interval = interval;
        this.requests = [];
    }

    async waitForSlot() {
        const now = Date.now();
        this.requests = this.requests.filter(time => now - time < this.interval);
        
        if (this.requests.length >= this.requestsPerMinute) {
            const oldestRequest = this.requests[0];
            const waitTime = this.interval - (now - oldestRequest);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return this.waitForSlot();
        }
        
        this.requests.push(now);
    }
}

const rateLimiter = new RateLimiter(config.rateLimit.requestsPerMinute, config.rateLimit.interval);

// Checkpoint management
class CheckpointManager {
    constructor(config) {
        this.config = config;
        this.checkpointFile = config.checkpoint.file;
        this.processedUrls = new Set();
        this.loadCheckpoint();
    }

    loadCheckpoint() {
        try {
            if (fs.existsSync(this.checkpointFile)) {
                const data = JSON.parse(fs.readFileSync(this.checkpointFile, 'utf8'));
                this.processedUrls = new Set(data.processedUrls);
                logger.info(`Loaded checkpoint with ${this.processedUrls.size} processed URLs`);
            }
        } catch (error) {
            logger.warn(`Could not load checkpoint: ${error.message}`);
        }
    }

    saveCheckpoint() {
        try {
            const data = {
                processedUrls: Array.from(this.processedUrls),
                timestamp: new Date().toISOString()
            };
            fs.writeFileSync(this.checkpointFile, JSON.stringify(data, null, 2));
            logger.debug('Checkpoint saved');
        } catch (error) {
            logger.error(`Failed to save checkpoint: ${error.message}`);
        }
    }

    isProcessed(url) {
        return this.processedUrls.has(url);
    }

    markAsProcessed(url) {
        this.processedUrls.add(url);
        if (this.processedUrls.size % this.config.checkpoint.interval === 0) {
            this.saveCheckpoint();
        }
    }

    clear() {
        try {
            if (fs.existsSync(this.checkpointFile)) {
                fs.unlinkSync(this.checkpointFile);
                this.processedUrls.clear();
                logger.info('Checkpoint cleared');
            }
        } catch (error) {
            logger.error(`Failed to clear checkpoint: ${error.message}`);
        }
    }
}

const checkpointManager = new CheckpointManager(config);

// Progress tracking
class ProgressTracker {
    constructor(total) {
        this.total = total;
        this.current = 0;
        this.spinner = ora('Starting analysis...').start();
    }

    update(message) {
        this.current++;
        const percentage = Math.round((this.current / this.total) * 100);
        this.spinner.text = `${message} (${percentage}%)`;
    }

    succeed(message) {
        this.spinner.succeed(message);
    }

    fail(message) {
        this.spinner.fail(message);
    }
}

// Error handling and retries
async function makeRequest(url, strategy = 'mobile', retryCount = 0) {
    try {
        await rateLimiter.waitForSlot();
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        if (retryCount < config.maxRetries) {
            console.log(`Retry attempt ${retryCount + 1} for ${url}`);
            await new Promise(resolve => setTimeout(resolve, config.retryDelay * (retryCount + 1)));
            return makeRequest(url, strategy, retryCount + 1);
        }
        throw new Error(`Failed to fetch data for ${url} after ${config.maxRetries} retries: ${error.message}`);
    }
}

function getDateString() {
    const date = new Date();
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day =`${date.getDate()}`.padStart(2, '0');
    return `${year}${month}${day}`
}

// Ensure output directory exists
function ensureOutputDirectory() {
    if (!fs.existsSync(config.output.directory)) {
        fs.mkdirSync(config.output.directory, { recursive: true });
        logger.info(`Created output directory: ${config.output.directory}`);
    }
}

function exportData(data) {
    const domain = (new URL(data[0][0].URL)).hostname.replace('www.','');
    const dateStr = getDateString();
    const filename = `${config.output.excel.prefix}${domain}${config.output.excel.suffix}_${dateStr}.xlsx`;
    const filepath = path.join(config.output.directory, filename);

    var wb = new xl.Workbook();
    var ws = wb.addWorksheet(domain);
    const header = wb.createStyle({
        font: { bold: true }
    });
    const good = wb.createStyle({
        fill: {
            type: 'pattern',
            patternType: 'solid',
            bgColor: '#92d050',
            fgColor: '#92d050',
        }
    });
    const needsImprovement = wb.createStyle({
        fill: {
            type: 'pattern',
            patternType: 'solid',
            bgColor: '#ffc000',
            fgColor: '#ffc000',
        }
    });
    const poor = wb.createStyle({
        fill: {
            type: 'pattern',
            patternType: 'solid',
            bgColor: '#ff0000',
            fgColor: '#ff0000',
        }
    });

    // Headers
    ws.cell(2, 1).string("URL").style(header)
    ws.cell(1, 2, 1, 3, 1, 4, 1, 5, 1, 6, 1, 7, true).string("Mobile Performance Metrics").style(header)
    ws.cell(1, 8, 1, 9, 1, 10, 1, 11, 1, 12, 1, 13, true).string("Desktop Performance Metrics").style(header)
    ws.cell(1, 14, 1, 15, 1, 16, true).string("Mobile Scores").style(header)
    ws.cell(1, 17, 1, 18, 1, 19, 1, 20, true).string("Desktop Scores").style(header)
    
    // Performance metrics headers
    ws.cell(2, 2).string("FCP").style(header)
    ws.cell(2, 3).string("SI").style(header)
    ws.cell(2, 4).string("LCP").style(header)
    ws.cell(2, 5).string("TBT").style(header)
    ws.cell(2, 6).string("CLS").style(header)
    ws.cell(2, 7).string("Score").style(header)
    ws.cell(2, 8).string("FCP").style(header)
    ws.cell(2, 9).string("SI").style(header)
    ws.cell(2, 10).string("LCP").style(header)
    ws.cell(2, 11).string("TBT").style(header)
    ws.cell(2, 12).string("CLS").style(header)
    ws.cell(2, 13).string("Score").style(header)
    
    // Category scores headers
    ws.cell(2, 14).string("Performance").style(header)
    ws.cell(2, 15).string("Accessibility").style(header)
    ws.cell(2, 16).string("Best Practices").style(header)
    ws.cell(2, 17).string("Performance").style(header)
    ws.cell(2, 18).string("Accessibility").style(header)
    ws.cell(2, 19).string("Best Practices").style(header)
    ws.cell(2, 20).string("SEO").style(header)

    for (const [i,row] of data.entries()) {
        ws.cell((i+3), 1).string(row[0].URL)
        
        // Mobile Performance metrics
        if(row[0].Mobile[0].FCP < 1.8) {
            ws.cell((i+3), 2).number(row[0].Mobile[0].FCP).style(good)
        }
        else if(row[0].Mobile[0].FCP >= 1.8 && row[0].Mobile[0].FCP < 3) {
            ws.cell((i+3), 2).number(row[0].Mobile[0].FCP).style(needsImprovement)
        }
        else if(row[0].Mobile[0].FCP > 3) {
            ws.cell((i+3), 2).number(row[0].Mobile[0].FCP).style(poor)
        }
        if(row[0].Mobile[0].SI < 3.4) {
            ws.cell((i+3), 3).number(row[0].Mobile[0].SI).style(good)
        }
        else if(row[0].Mobile[0].SI >= 3.4 && row[0].Mobile[0].SI < 5.8) {
            ws.cell((i+3), 3).number(row[0].Mobile[0].SI).style(needsImprovement)
        }
        else if(row[0].Mobile[0].SI > 5.8) {
            ws.cell((i+3), 3).number(row[0].Mobile[0].SI).style(poor)
        }
        if(row[0].Mobile[0].LCP < 2.5) {
            ws.cell((i+3), 4).number(row[0].Mobile[0].LCP).style(good)
        }
        else if(row[0].Mobile[0].LCP >= 2.5 && row[0].Mobile[0].LCP < 4) {
            ws.cell((i+3), 4).number(row[0].Mobile[0].LCP).style(needsImprovement)
        }
        else if(row[0].Mobile[0].LCP > 4) {
            ws.cell((i+3), 4).number(row[0].Mobile[0].LCP).style(poor)
        }
        if(row[0].Mobile[0].TBT < 200) {
            ws.cell((i+3), 5).number(row[0].Mobile[0].TBT).style(good)
        }
        else if(row[0].Mobile[0].TBT >= 200 && row[0].Mobile[0].TBT < 600) {
            ws.cell((i+3), 5).number(row[0].Mobile[0].TBT).style(needsImprovement)
        }
        else if(row[0].Mobile[0].TBT > 600) {
            ws.cell((i+3), 5).number(row[0].Mobile[0].TBT).style(poor)
        }
        if(row[0].Mobile[0].CLS < 0.1) {
            ws.cell((i+3), 6).number(row[0].Mobile[0].CLS).style(good)
        }
        else if(row[0].Mobile[0].CLS >= 0.1 && row[0].Mobile[0].CLS < 0.25) {
            ws.cell((i+3), 6).number(row[0].Mobile[0].CLS).style(needsImprovement)
        }
        else if(row[0].Mobile[0].CLS > 0.25) {
            ws.cell((i+3), 6).number(row[0].Mobile[0].CLS).style(poor)
        }

        // Mobile category scores
        if(row[0].Mobile[0].Performance >= 90) {
            ws.cell((i+3), 14).number(row[0].Mobile[0].Performance).style(good)
        }
        else if(row[0].Mobile[0].Performance >= 50 && row[0].Mobile[0].Performance < 90) {
            ws.cell((i+3), 14).number(row[0].Mobile[0].Performance).style(needsImprovement)
        }
        else if(row[0].Mobile[0].Performance < 50) {
            ws.cell((i+3), 14).number(row[0].Mobile[0].Performance).style(poor)
        }

        if(row[0].Mobile[0].Accessibility >= 90) {
            ws.cell((i+3), 15).number(row[0].Mobile[0].Accessibility).style(good)
        }
        else if(row[0].Mobile[0].Accessibility >= 50 && row[0].Mobile[0].Accessibility < 90) {
            ws.cell((i+3), 15).number(row[0].Mobile[0].Accessibility).style(needsImprovement)
        }
        else if(row[0].Mobile[0].Accessibility < 50) {
            ws.cell((i+3), 15).number(row[0].Mobile[0].Accessibility).style(poor)
        }

        if(row[0].Mobile[0].BestPractices >= 90) {
            ws.cell((i+3), 16).number(row[0].Mobile[0].BestPractices).style(good)
        }
        else if(row[0].Mobile[0].BestPractices >= 50 && row[0].Mobile[0].BestPractices < 90) {
            ws.cell((i+3), 16).number(row[0].Mobile[0].BestPractices).style(needsImprovement)
        }
        else if(row[0].Mobile[0].BestPractices < 50) {
            ws.cell((i+3), 16).number(row[0].Mobile[0].BestPractices).style(poor)
        }

        // Desktop Performance metrics
        if(row[0].Desktop[0].FCP < 1.8) {
            ws.cell((i+3), 8).number(row[0].Desktop[0].FCP).style(good)
        }
        else if(row[0].Desktop[0].FCP >= 1.8 && row[0].Desktop[0].FCP < 3) {
            ws.cell((i+3), 8).number(row[0].Desktop[0].FCP).style(needsImprovement)
        }
        else if(row[0].Desktop[0].FCP > 3) {
            ws.cell((i+3), 8).number(row[0].Desktop[0].FCP).style(poor)
        }
        if(row[0].Desktop[0].SI < 3.4) {
            ws.cell((i+3), 9).number(row[0].Desktop[0].SI).style(good)
        }
        else if(row[0].Desktop[0].SI >= 3.4 && row[0].Desktop[0].SI < 5.8) {
            ws.cell((i+3), 9).number(row[0].Desktop[0].SI).style(needsImprovement)
        }
        else if(row[0].Desktop[0].SI > 5.8) {
            ws.cell((i+3), 9).number(row[0].Desktop[0].SI).style(poor)
        }
        if(row[0].Desktop[0].LCP < 2.5) {
            ws.cell((i+3), 10).number(row[0].Desktop[0].LCP).style(good)
        }
        else if(row[0].Desktop[0].LCP >= 2.5 && row[0].Desktop[0].LCP < 4) {
            ws.cell((i+3), 10).number(row[0].Desktop[0].LCP).style(needsImprovement)
        }
        else if(row[0].Desktop[0].LCP > 4) {
            ws.cell((i+3), 10).number(row[0].Desktop[0].LCP).style(poor)
        }
        if(row[0].Desktop[0].TBT < 200) {
            ws.cell((i+3), 11).number(row[0].Desktop[0].TBT).style(good)
        }
        else if(row[0].Desktop[0].TBT >= 200 && row[0].Desktop[0].TBT < 600) {
            ws.cell((i+3), 11).number(row[0].Desktop[0].TBT).style(needsImprovement)
        }
        else if(row[0].Desktop[0].TBT > 600) {
            ws.cell((i+3), 11).number(row[0].Desktop[0].TBT).style(poor)
        }
        if(row[0].Desktop[0].CLS < 0.1) {
            ws.cell((i+3), 12).number(row[0].Desktop[0].CLS).style(good)
        }
        else if(row[0].Desktop[0].CLS >= 0.1 && row[0].Desktop[0].CLS < 0.25) {
            ws.cell((i+3), 12).number(row[0].Desktop[0].CLS).style(needsImprovement)
        }
        else if(row[0].Desktop[0].CLS > 0.25) {
            ws.cell((i+3), 12).number(row[0].Desktop[0].CLS).style(poor)
        }

        // Desktop category scores
        if(row[0].Desktop[0].Performance >= 90) {
            ws.cell((i+3), 17).number(row[0].Desktop[0].Performance).style(good)
        }
        else if(row[0].Desktop[0].Performance >= 50 && row[0].Desktop[0].Performance < 90) {
            ws.cell((i+3), 17).number(row[0].Desktop[0].Performance).style(needsImprovement)
        }
        else if(row[0].Desktop[0].Performance < 50) {
            ws.cell((i+3), 17).number(row[0].Desktop[0].Performance).style(poor)
        }

        if(row[0].Desktop[0].Accessibility >= 90) {
            ws.cell((i+3), 18).number(row[0].Desktop[0].Accessibility).style(good)
        }
        else if(row[0].Desktop[0].Accessibility >= 50 && row[0].Desktop[0].Accessibility < 90) {
            ws.cell((i+3), 18).number(row[0].Desktop[0].Accessibility).style(needsImprovement)
        }
        else if(row[0].Desktop[0].Accessibility < 50) {
            ws.cell((i+3), 18).number(row[0].Desktop[0].Accessibility).style(poor)
        }

        if(row[0].Desktop[0].BestPractices >= 90) {
            ws.cell((i+3), 19).number(row[0].Desktop[0].BestPractices).style(good)
        }
        else if(row[0].Desktop[0].BestPractices >= 50 && row[0].Desktop[0].BestPractices < 90) {
            ws.cell((i+3), 19).number(row[0].Desktop[0].BestPractices).style(needsImprovement)
        }
        else if(row[0].Desktop[0].BestPractices < 50) {
            ws.cell((i+3), 19).number(row[0].Desktop[0].BestPractices).style(poor)
        }

        if(row[0].Desktop[0].SEO >= 90) {
            ws.cell((i+3), 20).number(row[0].Desktop[0].SEO).style(good)
        }
        else if(row[0].Desktop[0].SEO >= 50 && row[0].Desktop[0].SEO < 90) {
            ws.cell((i+3), 20).number(row[0].Desktop[0].SEO).style(needsImprovement)
        }
        else if(row[0].Desktop[0].SEO < 50) {
            ws.cell((i+3), 20).number(row[0].Desktop[0].SEO).style(poor)
        }
    }
    wb.write(filepath);
    logger.info(`Excel report saved to: ${filepath}`);
}

function validateApiResponse(data, url) {
    if (!data || !data.lighthouseResult) {
        throw new Error(`Invalid API response for ${url}: Missing lighthouseResult`);
    }

    const { audits, categories } = data.lighthouseResult;
    if (!audits || !categories) {
        throw new Error(`Invalid API response for ${url}: Missing audits or categories`);
    }

    const requiredAudits = [
        'first-contentful-paint',
        'speed-index',
        'largest-contentful-paint',
        'total-blocking-time',
        'cumulative-layout-shift'
    ];

    const missingAudits = requiredAudits.filter(audit => !audits[audit]);
    if (missingAudits.length > 0) {
        throw new Error(`Invalid API response for ${url}: Missing required audits: ${missingAudits.join(', ')}`);
    }

    const requiredCategories = ['performance', 'accessibility', 'best-practices', 'seo'];
    const missingCategories = requiredCategories.filter(category => !categories[category]);
    if (missingCategories.length > 0) {
        throw new Error(`Invalid API response for ${url}: Missing required categories: ${missingCategories.join(', ')}`);
    }

    return true;
}

async function getData(url) {
    return new Promise(async (resolve) => {
        let retries = 0;
        const maxRetries = config.maxRetries;

        while (retries <= maxRetries) {
            try {
                await rateLimiter.waitForSlot();
                logger.debug(`Processing URL: ${url[0]}`);
                
                const [mobileResponse, desktopResponse] = await Promise.all([
                    axios.get(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${url[0]}&strategy=mobile&key=${config.API_KEY}`),
                    axios.get(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${url[0]}&strategy=desktop&key=${config.API_KEY}`)
                ]);

                const mobileData = mobileResponse.data;
                const desktopData = desktopResponse.data;

                // Validate API responses
                validateApiResponse(mobileData, `${url[0]} (mobile)`);
                validateApiResponse(desktopData, `${url[0]} (desktop)`);

                // Helper function to safely extract metrics
                const extractMetrics = (data) => {
                    try {
                        const audits = data.lighthouseResult.audits;
                        const categories = data.lighthouseResult.categories;
                        
                        const metrics = {
                            "FCP": parseFloat((audits["first-contentful-paint"]?.numericValue * 0.001 || 0).toFixed(2)),
                            "SI": parseFloat((audits["speed-index"]?.numericValue * 0.001 || 0).toFixed(2)),
                            "LCP": parseFloat((audits["largest-contentful-paint"]?.numericValue * 0.001 || 0).toFixed(2)),
                            "TBT": audits["total-blocking-time"]?.numericValue || 0,
                            "CLS": parseFloat((audits["cumulative-layout-shift"]?.numericValue || 0).toFixed(2)),
                            "Performance": Math.round((categories.performance?.score || 0) * 100),
                            "Accessibility": Math.round((categories.accessibility?.score || 0) * 100),
                            "BestPractices": Math.round((categories['best-practices']?.score || 0) * 100),
                            "SEO": Math.round((categories.seo?.score || 0) * 100)
                        };

                        // Validate metrics
                        Object.entries(metrics).forEach(([key, value]) => {
                            if (isNaN(value)) {
                                throw new Error(`Invalid metric value for ${key}: ${value}`);
                            }
                        });

                        return metrics;
                    } catch (error) {
                        console.error(`Error extracting metrics for ${url[0]}: ${error.message}`);
                        throw error; // Re-throw to trigger retry
                    }
                };

                const dataArray = [{
                    "URL": url,
                    "Mobile": [extractMetrics(mobileData)],
                    "Desktop": [extractMetrics(desktopData)]
                }];

                resolve(dataArray);
                break;
            } catch (error) {
                logger.error(`Error processing URL ${url[0]}: ${error.message}`);
                retries++;
                if (retries > maxRetries) {
                    logger.error(`Max retries (${maxRetries}) reached for ${url[0]}`);
                    resolve([{
                        "URL": url,
                        "Mobile": [{"FCP": 0, "SI": 0, "LCP": 0, "TBT": 0, "CLS": 0, "Performance": 0, "Accessibility": 0, "BestPractices": 0, "SEO": 0}],
                        "Desktop": [{"FCP": 0, "SI": 0, "LCP": 0, "TBT": 0, "CLS": 0, "Performance": 0, "Accessibility": 0, "BestPractices": 0, "SEO": 0}]
                    }]);
                } else {
                    const delay = config.retryDelay * Math.pow(2, retries - 1);
                    logger.info(`Retrying ${url[0]} (attempt ${retries} of ${maxRetries}) after ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
    });
}

async function getURLs(siteMap) {
    try {
        const parser = new SitemapXMLParser();
        const urls = await parser.fetch(siteMap);
        console.log(`Found ${urls.length} URLs in sitemap`);
        return urls;
    } catch (error) {
        console.error('Error fetching sitemap:', error);
        throw error;
    }
}

// Add after the config object
const BATCH_SIZE = 5; // Number of URLs to process in parallel

async function processBatch(urls) {
    return Promise.all(urls.map(url => getData([url])));
}

function generateSummary(results) {
    const summary = {
        total: results.length,
        successful: 0,
        failed: 0,
        metrics: {
            mobile: {
                performance: { good: 0, needsImprovement: 0, poor: 0 },
                accessibility: { good: 0, needsImprovement: 0, poor: 0 },
                bestPractices: { good: 0, needsImprovement: 0, poor: 0 }
            },
            desktop: {
                performance: { good: 0, needsImprovement: 0, poor: 0 },
                accessibility: { good: 0, needsImprovement: 0, poor: 0 },
                bestPractices: { good: 0, needsImprovement: 0, poor: 0 },
                seo: { good: 0, needsImprovement: 0, poor: 0 }
            }
        }
    };

    results.forEach(result => {
        const mobile = result[0].Mobile[0];
        const desktop = result[0].Desktop[0];

        // Check if the result is valid (not all zeros)
        const isValid = mobile.Performance !== 0 || desktop.Performance !== 0;
        if (isValid) {
            summary.successful++;
        } else {
            summary.failed++;
        }

        // Mobile metrics
        if (mobile.Performance >= 90) summary.metrics.mobile.performance.good++;
        else if (mobile.Performance >= 50) summary.metrics.mobile.performance.needsImprovement++;
        else summary.metrics.mobile.performance.poor++;

        if (mobile.Accessibility >= 90) summary.metrics.mobile.accessibility.good++;
        else if (mobile.Accessibility >= 50) summary.metrics.mobile.accessibility.needsImprovement++;
        else summary.metrics.mobile.accessibility.poor++;

        if (mobile.BestPractices >= 90) summary.metrics.mobile.bestPractices.good++;
        else if (mobile.BestPractices >= 50) summary.metrics.mobile.bestPractices.needsImprovement++;
        else summary.metrics.mobile.bestPractices.poor++;

        // Desktop metrics
        if (desktop.Performance >= 90) summary.metrics.desktop.performance.good++;
        else if (desktop.Performance >= 50) summary.metrics.desktop.performance.needsImprovement++;
        else summary.metrics.desktop.performance.poor++;

        if (desktop.Accessibility >= 90) summary.metrics.desktop.accessibility.good++;
        else if (desktop.Accessibility >= 50) summary.metrics.desktop.accessibility.needsImprovement++;
        else summary.metrics.desktop.accessibility.poor++;

        if (desktop.BestPractices >= 90) summary.metrics.desktop.bestPractices.good++;
        else if (desktop.BestPractices >= 50) summary.metrics.desktop.bestPractices.needsImprovement++;
        else summary.metrics.desktop.bestPractices.poor++;

        if (desktop.SEO >= 90) summary.metrics.desktop.seo.good++;
        else if (desktop.SEO >= 50) summary.metrics.desktop.seo.needsImprovement++;
        else summary.metrics.desktop.seo.poor++;
    });

    return summary;
}

function printSummary(summary) {
    console.log('\n=== Performance Analysis Summary ===');
    console.log(`Total URLs analyzed: ${summary.total}`);
    console.log(`Successful: ${summary.successful}`);
    console.log(`Failed: ${summary.failed}`);
    
    console.log('\nMobile Metrics:');
    console.log('Performance:');
    console.log(`  Good: ${summary.metrics.mobile.performance.good}`);
    console.log(`  Needs Improvement: ${summary.metrics.mobile.performance.needsImprovement}`);
    console.log(`  Poor: ${summary.metrics.mobile.performance.poor}`);
    
    console.log('\nAccessibility:');
    console.log(`  Good: ${summary.metrics.mobile.accessibility.good}`);
    console.log(`  Needs Improvement: ${summary.metrics.mobile.accessibility.needsImprovement}`);
    console.log(`  Poor: ${summary.metrics.mobile.accessibility.poor}`);
    
    console.log('\nBest Practices:');
    console.log(`  Good: ${summary.metrics.mobile.bestPractices.good}`);
    console.log(`  Needs Improvement: ${summary.metrics.mobile.bestPractices.needsImprovement}`);
    console.log(`  Poor: ${summary.metrics.mobile.bestPractices.poor}`);
    
    console.log('\nDesktop Metrics:');
    console.log('Performance:');
    console.log(`  Good: ${summary.metrics.desktop.performance.good}`);
    console.log(`  Needs Improvement: ${summary.metrics.desktop.performance.needsImprovement}`);
    console.log(`  Poor: ${summary.metrics.desktop.performance.poor}`);
    
    console.log('\nAccessibility:');
    console.log(`  Good: ${summary.metrics.desktop.accessibility.good}`);
    console.log(`  Needs Improvement: ${summary.metrics.desktop.accessibility.needsImprovement}`);
    console.log(`  Poor: ${summary.metrics.desktop.accessibility.poor}`);
    
    console.log('\nBest Practices:');
    console.log(`  Good: ${summary.metrics.desktop.bestPractices.good}`);
    console.log(`  Needs Improvement: ${summary.metrics.desktop.bestPractices.needsImprovement}`);
    console.log(`  Poor: ${summary.metrics.desktop.bestPractices.poor}`);
    
    console.log('\nSEO:');
    console.log(`  Good: ${summary.metrics.desktop.seo.good}`);
    console.log(`  Needs Improvement: ${summary.metrics.desktop.seo.needsImprovement}`);
    console.log(`  Poor: ${summary.metrics.desktop.seo.poor}`);
}

// Update the start function
async function start() {
    try {
        ensureOutputDirectory();
        logger.info('Starting performance analysis...');
        const urls = await getURLs(config.siteMap);
        const results = [];
        let processed = 0;

        // Filter out already processed URLs
        const urlsToProcess = urls.filter(url => !checkpointManager.isProcessed(url));
        logger.info(`Found ${urls.length} total URLs, ${urlsToProcess.length} remaining to process`);

        const progress = new ProgressTracker(urlsToProcess.length);

        // Process URLs in batches
        for (let i = 0; i < urlsToProcess.length; i += BATCH_SIZE) {
            const batch = urlsToProcess.slice(i, i + BATCH_SIZE);
            logger.info(`Processing batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(urlsToProcess.length/BATCH_SIZE)}`);
            
            const batchResults = await processBatch(batch);
            results.push(...batchResults);
            
            // Mark URLs as processed
            batch.forEach(url => checkpointManager.markAsProcessed(url));
            
            processed += batch.length;
            progress.update(`Processed ${processed} URLs`);
        }

        logger.info('Exporting results to Excel...');
        exportData(results);

        // Generate and print summary
        const summary = generateSummary(results);
        printSummary(summary);

        // Export summary to file
        const domain = (new URL(results[0][0].URL)).hostname.replace('www.','');
        const summaryFile = path.join(
            config.output.directory,
            `${config.output.summary.prefix}${domain}${config.output.summary.suffix}_${getDateString()}.json`
        );
        fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
        logger.info(`Summary exported to ${summaryFile}`);

        progress.succeed('Analysis completed successfully');
        checkpointManager.clear(); // Clear checkpoint after successful completion
    } catch (error) {
        logger.error('Fatal error:', error);
        process.exit(1);
    }
}

start();