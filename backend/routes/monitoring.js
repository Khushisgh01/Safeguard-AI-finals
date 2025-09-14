

const express = require('express');
const { body, validationResult } = require('express-validator');
const Monitoring = require('../models/Monitoring');
const Alert = require('../models/Alert');
const Contact = require('../models/Contact');
const smsService = require('../services/smsService');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

/* ======================== START / STOP / PAUSE / RESUME ======================== */

// @desc    Start monitoring session
// @route   POST /api/monitoring/start
// @access  Private
router.post(
  '/start',
  protect,
  [
    body('deviceInfo.deviceId').notEmpty().withMessage('Device ID is required'),
    body('deviceInfo.deviceType').notEmpty().withMessage('Device type is required'),
    body('deviceInfo.location').optional().isString().withMessage('Location must be a string'),
    body('aiAnalysis.confidence').optional().isFloat({ min: 0, max: 1 }).withMessage('AI confidence must be between 0 and 1'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, error: { message: 'Validation failed', details: errors.array() } });
      }

      const { deviceInfo, aiAnalysis, privacySettings } = req.body;

      const existingSession = await Monitoring.findOne({ userId: req.user._id, status: 'active' });
      if (existingSession) {
        return res.status(400).json({ success: false, error: { message: 'User already has an active monitoring session' } });
      }

      const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      const monitoring = await Monitoring.create({
        userId: req.user._id,
        sessionId,
        deviceInfo: { ...deviceInfo, ipAddress: req.ip },
        aiAnalysis: { ...(aiAnalysis || {}), lastUpdate: new Date() },
        privacySettings: privacySettings || {},
      });

      res.status(201).json({
        success: true,
        data: { monitoring, sessionId: monitoring.sessionId },
        message: 'Monitoring session started successfully',
      });
    } catch (error) {
      console.error('Start monitoring error:', error);
      res.status(500).json({ success: false, error: { message: 'Server error while starting monitoring session' } });
    }
  }
);

// @desc    Stop monitoring session
// @route   PUT /api/monitoring/stop/:sessionId
// @access  Private
router.put('/stop/:sessionId', protect, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const monitoring = await Monitoring.findOne({ sessionId, userId: req.user._id });

    if (!monitoring) return res.status(404).json({ success: false, error: { message: 'Monitoring session not found' } });
    if (monitoring.status === 'stopped') {
      return res.status(400).json({ success: false, error: { message: 'Monitoring session is already stopped' } });
    }

    monitoring.status = 'stopped';
    monitoring.endTime = new Date();
    await monitoring.save();

    res.json({ success: true, data: { monitoring }, message: 'Monitoring session stopped successfully' });
  } catch (error) {
    console.error('Stop monitoring error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while stopping monitoring session' } });
  }
});

// @desc    Pause monitoring session
// @route   PUT /api/monitoring/pause/:sessionId
// @access  Private
router.put('/pause/:sessionId', protect, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const monitoring = await Monitoring.findOne({ sessionId, userId: req.user._id });
    if (!monitoring) return res.status(404).json({ success: false, error: { message: 'Monitoring session not found' } });
    if (monitoring.status !== 'active') {
      return res.status(400).json({ success: false, error: { message: 'Only active sessions can be paused' } });
    }
    monitoring.status = 'paused';
    await monitoring.save();
    res.json({ success: true, data: { monitoring }, message: 'Monitoring session paused successfully' });
  } catch (error) {
    console.error('Pause monitoring error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while pausing monitoring session' } });
  }
});

// @desc    Resume monitoring session
// @route   PUT /api/monitoring/resume/:sessionId
// @access  Private
router.put('/resume/:sessionId', protect, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const monitoring = await Monitoring.findOne({ sessionId, userId: req.user._id });
    if (!monitoring) return res.status(404).json({ success: false, error: { message: 'Monitoring session not found' } });
    if (monitoring.status !== 'paused') {
      return res.status(400).json({ success: false, error: { message: 'Only paused sessions can be resumed' } });
    }
    monitoring.status = 'active';
    await monitoring.save();
    res.json({ success: true, data: { monitoring }, message: 'Monitoring session resumed successfully' });
  } catch (error) {
    console.error('Resume monitoring error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while resuming monitoring session' } });
  }
});

/* ======================== ACTIVITY INGESTION (existing behavior) ======================== */

// @desc    Add activity data
// @route   POST /api/monitoring/:sessionId/activity
// @access  Private
router.post(
  '/:sessionId/activity',
  protect,
  [
    body('activityType').isIn(['sleep', 'walk', 'sit', 'stand', 'fall', 'inactivity', 'unknown']).withMessage('Invalid activity type'),
    body('confidence').isFloat({ min: 0, max: 1 }).withMessage('Confidence must be between 0 and 1'),
    body('duration').optional().isInt({ min: 0 }).withMessage('Duration must be a positive integer'),
    body('location').optional().isString().withMessage('Location must be a string'),
    body('riskLevel').optional().isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid risk level'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, error: { message: 'Validation failed', details: errors.array() } });
      }

      const { sessionId } = req.params;
      const activityData = req.body;

      const monitoring = await Monitoring.findOne({ sessionId, userId: req.user._id });
      if (!monitoring) return res.status(404).json({ success: false, error: { message: 'Monitoring session not found' } });
      if (monitoring.status !== 'active') {
        return res.status(400).json({ success: false, error: { message: 'Cannot add activity to inactive session' } });
      }

      await monitoring.addActivity(activityData);

      if (activityData.riskLevel === 'high' || activityData.riskLevel === 'critical') {
        const alert = await Alert.create({
          userId: req.user._id,
          monitoringSessionId: monitoring._id,
          alertType: activityData.activityType === 'fall' ? 'fall' : 'medical',
          severity: activityData.riskLevel,
          title: `${activityData.activityType.charAt(0).toUpperCase() + activityData.activityType.slice(1)} detected`,
          description: `High-risk activity detected: ${activityData.activityType} with ${Math.round(activityData.confidence * 100)}% confidence`,
          location: activityData.location,
          metadata: {
            activityType: activityData.activityType,
            confidence: activityData.confidence,
            duration: activityData.duration,
            riskFactors: [activityData.activityType],
          },
        });

        try {
          const contacts = await Contact.getAvailableContactsForAlert(req.user._id, alert.alertType, new Date());
          for (const contact of contacts) {
            if (contact.notificationPreferences.email.enabled) {
              await alert.addNotification(contact._id, 'email');
            }
            if (contact.notificationPreferences.sms.enabled) {
              await alert.addNotification(contact._id, 'sms');
              smsService
                .sendAlertSMS(contact.phone, alert)
                .then(() => alert.updateNotificationStatus(contact._id, 'sent', 'SMS sent'))
                .catch((err) => alert.updateNotificationStatus(contact._id, 'failed', err?.message || 'SMS failed'));
            }
            if (contact.notificationPreferences.push.enabled) {
              await alert.addNotification(contact._id, 'push');
            }
          }
        } catch (notifyErr) {
          console.error('Notification error for monitoring alert:', notifyErr);
        }

        monitoring.alerts.push({ alertId: alert._id, timestamp: new Date(), severity: activityData.riskLevel, resolved: false });
        await monitoring.save();
      }

      res.json({ success: true, data: { monitoring }, message: 'Activity data added successfully' });
    } catch (error) {
      console.error('Add activity error:', error);
      res.status(500).json({ success: false, error: { message: 'Server error while adding activity data' } });
    }
  }
);

/* ======================== SESSION & STATS QUERIES (existing behavior) ======================== */

// @desc    Get monitoring session
// @route   GET /api/monitoring/:sessionId
// @access  Private
router.get('/:sessionId', protect, async (req, res) => {
  try {
    const monitoring = await Monitoring.findOne({ sessionId: req.params.sessionId, userId: req.user._id }).populate('alerts.alertId');
    if (!monitoring) return res.status(404).json({ success: false, error: { message: 'Monitoring session not found' } });
    res.json({ success: true, data: { monitoring } });
  } catch (error) {
    console.error('Get monitoring error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while fetching monitoring session' } });
  }
});

// @desc    Get user's monitoring sessions
// @route   GET /api/monitoring
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const { page = 1, limit = 10, status, startDate, endDate } = req.query;
    const query = { userId: req.user._id };
    if (status) query.status = status;
    if (startDate && endDate) {
      query.startTime = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const options = { page: parseInt(page), limit: parseInt(limit), sort: { startTime: -1 } };

    const sessions = await Monitoring.find(query)
      .sort(options.sort)
      .limit(options.limit)
      .skip((options.page - 1) * options.limit)
      .populate('alerts.alertId');

    const total = await Monitoring.countDocuments(query);

    res.json({
      success: true,
      data: { sessions, pagination: { page: options.page, limit: options.limit, total, pages: Math.ceil(total / options.limit) } },
    });
  } catch (error) {
    console.error('Get monitoring sessions error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while fetching monitoring sessions' } });
  }
});

// @desc    Get monitoring stats
// @route   GET /api/monitoring/stats/overview
// @access  Private
router.get('/stats/overview', protect, async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const stats = await Monitoring.aggregate([
      { $match: { userId: req.user._id, startTime: { $gte: startDate } } },
      {
        $group: {
          _id: null,
          totalSessions: { $sum: 1 },
          totalDuration: { $sum: { $subtract: ['$endTime', '$startTime'] } },
          avgSessionDuration: { $avg: { $subtract: ['$endTime', '$startTime'] } },
          activeSessions: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          totalActivities: { $sum: { $size: '$activities' } },
          highRiskActivities: {
            $sum: {
              $size: { $filter: { input: '$activities', cond: { $in: ['$$this.riskLevel', ['high', 'critical']] } } },
            },
          },
        },
      },
    ]);

    const activityBreakdown = await Monitoring.aggregate([
      { $match: { userId: req.user._id, startTime: { $gte: startDate } } },
      { $unwind: '$activities' },
      { $group: { _id: '$activities.activityType', count: { $sum: 1 }, avgConfidence: { $avg: '$activities.confidence' } } },
      { $sort: { count: -1 } },
    ]);

    res.json({
      success: true,
      data: {
        overview:
          stats[0] || { totalSessions: 0, totalDuration: 0, avgSessionDuration: 0, activeSessions: 0, totalActivities: 0, highRiskActivities: 0 },
        activityBreakdown,
        timeRange: { start: startDate, end: new Date(), days: parseInt(days) },
      },
    });
  } catch (error) {
    console.error('Get monitoring stats error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while fetching monitoring statistics' } });
  }
});

/* ======================== QUICK EVENT INGESTION (NEW) ======================== */

const {
  normalizeType,
  isDanger,
  severityFor,
  shouldFire,
  DEFAULT_INACTIVITY_THRESHOLD_MS,
} = require('../services/monitoringRules');
const { notifyContacts } = require('../services/notificationService');
const User = require('../models/User');

// @desc    Fast ingest from client model: decide + alert + SMS (cooldown safe)
// @route   POST /api/monitoring/event
// @access  Private
router.post('/event', protect, async (req, res, next) => {
  try {
    const userId = req.user._id;
    const {
      sessionId,
      type,
      confidence = 0,
      durationMs = 0,
      location = null,
      coordinates = null,
      modelVersion = null,
    } = req.body;

    if (!sessionId) {
      return res.status(400).json({ success: false, error: { message: 'sessionId is required' } });
    }

    const normType = normalizeType(type);

    // upsert session
    let session = await Monitoring.findOne({ sessionId, userId });
    if (!session) {
      session = await Monitoring.create({
        userId,
        sessionId,
        status: 'active',
        deviceInfo: { ipAddress: req.ip },
        aiAnalysis: { isEnabled: true, modelVersion, lastUpdate: new Date() },
      });
    } else {
      session.aiAnalysis = { ...(session.aiAnalysis || {}), modelVersion: modelVersion || session.aiAnalysis?.modelVersion, lastUpdate: new Date() };
    }

    // record activity
    await session.addActivity({
      activityType: normType === 'unknown' ? 'unknown' : normType,
      confidence: Number(confidence) || 0,
      duration: durationMs ? Math.round(Number(durationMs) / 1000) : undefined,
      location: location || undefined,
      riskLevel: normType === 'fall' ? 'critical' : normType === 'inactivity' ? 'medium' : 'low',
      metadata: {},
    });

    const danger = isDanger({ type: normType, durationMs });
    let alert = null;
    let notified = null;

    if (danger && shouldFire(userId, normType)) {
      const severity = severityFor({ type: normType, confidence, durationMs });

      const user = await User.findById(userId).select('firstName lastName');
      const who = user ? `${user.firstName} ${user.lastName}` : 'User';
      const when = new Date().toLocaleString();
      const pretty =
        normType === 'fall'
          ? `ALERT: Possible FALL detected for ${who} at ${when}.`
          : `ALERT: Prolonged INACTIVITY detected for ${who} at ${when}.`;

      const details = [];
      if (confidence) details.push(`confidence=${(Number(confidence) * 100).toFixed(0)}%`);
      if (durationMs) details.push(`duration=${Math.round(Number(durationMs) / 1000)}s`);

      const message = [pretty, details.length ? `(${details.join(', ')})` : null, location ? `Location: ${location}` : null]
        .filter(Boolean)
        .join(' ');

      alert = await Alert.create({
        userId,
        monitoringSessionId: session._id,
        alertType: normType,
        severity,
        status: 'active',
        title: normType === 'fall' ? 'Fall suspected' : 'Prolonged inactivity detected',
        description: message,
        location: location || null,
        coordinates: coordinates && coordinates.lat != null ? { latitude: coordinates.lat, longitude: coordinates.lng } : undefined,
        timestamp: new Date(),
        metadata: {
          activityType: normType,
          confidence: Number(confidence) || 0,
          duration: durationMs ? Math.round(Number(durationMs) / 1000) : undefined,
          aiAnalysis: { modelVersion },
        },
        tags: ['auto', 'monitoring'],
      });

      // choose contacts (active + sms enabled + relevant alert type)
      const contacts = await Contact.getAvailableContactsForAlert(userId, normType, new Date());
      const numbers = contacts.map((c) => c.phone).filter(Boolean);

      if (numbers.length) {
        notified = await notifyContacts({ numbers, message });

        try {
          for (const item of notified.sms) {
            alert.notifications.push({
              contactId: null,
              contactType: 'sms',
              sentAt: new Date(),
              status: item.ok ? 'sent' : 'failed',
              deliveryAttempts: 1,
              lastAttempt: new Date(),
              response: item.ok ? JSON.stringify(item.data) : item.error,
            });
          }
          await alert.save();
        } catch (e) {
          console.warn('Failed to record SMS results:', e?.message);
        }
      }
    }

    res.json({
      success: true,
      data: {
        sessionId,
        type: normType,
        confidence: Number(confidence) || 0,
        durationMs: Number(durationMs) || 0,
        danger,
        thresholds: { inactivityMs: DEFAULT_INACTIVITY_THRESHOLD_MS },
        ...(alert ? { alertId: alert._id } : {}),
        ...(notified ? { notified } : {}),
      },
    });
  } catch (err) {
    next(err);
  }
});

// @desc    Server thresholds for client
// @route   GET /api/monitoring/config
// @access  Private
router.get('/config', protect, async (_req, res) => {
  const { DEFAULT_INACTIVITY_THRESHOLD_MS } = require('../services/monitoringRules');
  const cooldown = Number(process.env.ALERT_COOLDOWN_MS || 2 * 60 * 1000);
  res.json({ success: true, data: { inactivityThresholdMs: DEFAULT_INACTIVITY_THRESHOLD_MS, cooldownMs: cooldown } });
});

/* ======================== ADMIN (unchanged) ======================== */

// @desc    Get active monitoring sessions (Admin only)
// @route   GET /api/monitoring/admin/active
// @access  Private, Admin only
router.get('/admin/active', protect, authorize('admin'), async (_req, res) => {
  try {
    const activeSessions = await Monitoring.getActiveSessions();
    res.json({ success: true, data: { activeSessions } });
  } catch (error) {
    console.error('Get active sessions error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while fetching active sessions' } });
  }
});

module.exports = router;