const express = require('express');
const { body, validationResult } = require('express-validator');
const Alert = require('../models/Alert');
const Contact = require('../models/Contact');
const smsService = require('../services/smsService');
const { sendEmail, buildAlertEmail } = require('../services/emailService');
const { sendPush, buildAlertPush, buildSosPush } = require('../services/pushService');
const sosService = require('../services/sosService');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

function getAlertRecipientsFromEnv() {
  const raw = process.env.ALERT_EMAIL_TO || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// @desc    Get user's alerts
// @route   GET /api/alerts
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const { page = 1, limit = 10, status, severity, alertType } = req.query;

    const query = { userId: req.user._id };
    if (status) query.status = status;
    if (severity) query.severity = severity;
    if (alertType) query.alertType = alertType;

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { priority: -1, timestamp: -1 }
    };

    const alerts = await Alert.find(query)
      .sort(options.sort)
      .limit(options.limit)
      .skip((options.page - 1) * options.limit)
      .populate('monitoringSessionId', 'sessionId deviceInfo');

    const total = await Alert.countDocuments(query);

    res.json({
      success: true,
      data: {
        alerts,
        pagination: {
          page: options.page,
          limit: options.limit,
          total,
          pages: Math.ceil(total / options.limit)
        }
      }
    });
  } catch (error) {
    console.error('Get alerts error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while fetching alerts' } });
  }
});

// @desc    Send a test push notification to verify watch integration
// @route   POST /api/alerts/push-test
// @access  Private
router.post('/push-test', protect, async (req, res) => {
  try {
    const push = buildSosPush('Test from Dashboard');
    const result = await sendPush({ ...push, title: 'FamilySafe Watch Test' });
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

// @desc    Get alert by ID
// @route   GET /api/alerts/:id
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    const alert = await Alert.findOne({
      _id: req.params.id,
      userId: req.user._id
    }).populate('monitoringSessionId', 'sessionId deviceInfo');

    if (!alert) {
      return res.status(404).json({ success: false, error: { message: 'Alert not found' } });
    }

    res.json({ success: true, data: { alert } });
  } catch (error) {
    console.error('Get alert error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while fetching alert' } });
  }
});

// @desc    Create new alert
// @route   POST /api/alerts
// @access  Private
router.post(
  '/',
  protect,
  [
    body('alertType')
      .isIn(['fall', 'inactivity', 'medical', 'security', 'wellness', 'system'])
      .withMessage('Invalid alert type'),
    body('severity').isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid severity level'),
    body('title').trim().isLength({ min: 1, max: 100 }).withMessage('Title must be between 1 and 100 characters'),
    body('description')
      .trim()
      .isLength({ min: 1, max: 500 })
      .withMessage('Description must be between 1 and 500 characters'),
    body('location').optional().isString().withMessage('Location must be a string'),
    body('coordinates.latitude').optional().isFloat({ min: -90, max: 90 }).withMessage('Latitude must be between -90 and 90'),
    body('coordinates.longitude').optional().isFloat({ min: -180, max: 180 }).withMessage('Longitude must be between -180 and 180')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: { message: 'Validation failed', details: errors.array() }
        });
      }

      const alertData = { ...req.body, userId: req.user._id };
      const alert = await Alert.create(alertData);

      // Get available contacts for this alert type
      const contacts = await Contact.getAvailableContactsForAlert(req.user._id, alert.alertType, new Date());

      const recipients = getAlertRecipientsFromEnv();
      // Add notifications for each contact and notify immediately (email + SMS + Push)
      for (const contact of contacts) {
        if (contact.notificationPreferences.email.enabled) {
          await alert.addNotification(contact._id, 'email');
          if (recipients.length) {
            try {
              const payload = buildAlertEmail(alert, req.user);
              const result = await sendEmail({ to: recipients, ...payload });
              await alert.updateNotificationStatus(contact._id, 'sent', `Email sent: ${result.messageId || 'ok'}`);
            } catch (err) {
              console.error('Email send failed:', err?.message);
              await alert.updateNotificationStatus(contact._id, 'failed', err?.message || 'Email failed');
            }
          } else {
            console.warn('No ALERT_EMAIL_TO configured; skipping email send.');
            await alert.updateNotificationStatus(contact._id, 'failed', 'No ALERT_EMAIL_TO configured');
          }
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
          const push = buildAlertPush(alert);
          sendPush(push).catch((e) => console.error('Push send failed:', e?.message));
        }
      }

      await alert.populate('monitoringSessionId', 'sessionId deviceInfo');

      res.status(201).json({
        success: true,
        data: { alert },
        message: 'Alert created successfully'
      });
    } catch (error) {
      console.error('Create alert error:', error);
      res.status(500).json({ success: false, error: { message: 'Server error while creating alert' } });
    }
  }
);

// @desc    Acknowledge alert
// @route   PUT /api/alerts/:id/acknowledge
// @access  Private
router.put('/:id/acknowledge', protect, async (req, res) => {
  try {
    const alert = await Alert.findOne({ _id: req.params.id, userId: req.user._id });
    if (!alert) return res.status(404).json({ success: false, error: { message: 'Alert not found' } });
    if (alert.status === 'resolved') {
      return res.status(400).json({ success: false, error: { message: 'Cannot acknowledge resolved alert' } });
    }
    await alert.acknowledge(req.user._id);
    res.json({ success: true, data: { alert }, message: 'Alert acknowledged successfully' });
  } catch (error) {
    console.error('Acknowledge alert error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while acknowledging alert' } });
  }
});

// @desc    Resolve alert
// @route   PUT /api/alerts/:id/resolve
// @access  Private
router.put('/:id/resolve', protect, async (req, res) => {
  try {
    const alert = await Alert.findOne({ _id: req.params.id, userId: req.user._id });
    if (!alert) return res.status(404).json({ success: false, error: { message: 'Alert not found' } });
    if (alert.status === 'resolved') {
      return res.status(400).json({ success: false, error: { message: 'Alert is already resolved' } });
    }
    await alert.resolve(req.user._id);
    res.json({ success: true, data: { alert }, message: 'Alert resolved successfully' });
  } catch (error) {
    console.error('Resolve alert error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while resolving alert' } });
  }
});

// @desc    Escalate alert
// @route   PUT /api/alerts/:id/escalate
// @access  Private
router.put(
  '/:id/escalate',
  protect,
  [body('contactType').isIn(['email', 'sms', 'push']).withMessage('Invalid contact type'), body('contactId').notEmpty().withMessage('Contact ID is required')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, error: { message: 'Validation failed', details: errors.array() } });
      }

      const { contactType, contactId } = req.body;

      const alert = await Alert.findOne({ _id: req.params.id, userId: req.user._id });
      if (!alert) return res.status(404).json({ success: false, error: { message: 'Alert not found' } });
      if (alert.status === 'resolved') {
        return res.status(400).json({ success: false, error: { message: 'Cannot escalate resolved alert' } });
      }

      await alert.escalate(contactType, contactId);
      res.json({ success: true, data: { alert }, message: 'Alert escalated successfully' });
    } catch (error) {
      console.error('Escalate alert error:', error);
      res.status(500).json({ success: false, error: { message: 'Server error while escalating alert' } });
    }
  }
);

// @desc    Update alert
// @route   PUT /api/alerts/:id
// @access  Private
router.put(
  '/:id',
  protect,
  [
    body('title').optional().trim().isLength({ min: 1, max: 100 }).withMessage('Title must be between 1 and 100 characters'),
    body('description').optional().trim().isLength({ min: 1, max: 500 }).withMessage('Description must be between 1 and 500 characters'),
    body('tags').optional().isArray().withMessage('Tags must be an array'),
    body('autoResolve').optional().isBoolean().withMessage('autoResolve must be a boolean'),
    body('autoResolveAfter').optional().isInt({ min: 1, max: 1440 }).withMessage('Auto resolve time must be between 1 and 1440 minutes')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, error: { message: 'Validation failed', details: errors.array() } });
      }

      const { title, description, tags, autoResolve, autoResolveAfter } = req.body;
      const updateFields = {};

      if (title) updateFields.title = title;
      if (description) updateFields.description = description;
      if (tags) updateFields.tags = tags;
      if (autoResolve !== undefined) updateFields.autoResolve = autoResolve;
      if (autoResolveAfter) updateFields.autoResolveAfter = autoResolveAfter;

      const alert = await Alert.findOneAndUpdate(
        { _id: req.params.id, userId: req.user._id },
        updateFields,
        { new: true, runValidators: true }
      ).populate('monitoringSessionId', 'sessionId deviceInfo');

      if (!alert) {
        return res.status(404).json({ success: false, error: { message: 'Alert not found' } });
      }

      res.json({ success: true, data: { alert }, message: 'Alert updated successfully' });
    } catch (error) {
      console.error('Update alert error:', error);
      res.status(500).json({ success: false, error: { message: 'Server error while updating alert' } });
    }
  }
);

// @desc    Delete alert
// @route   DELETE /api/alerts/:id
// @access  Private
router.delete('/:id', protect, async (req, res) => {
  try {
    const alert = await Alert.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!alert) return res.status(404).json({ success: false, error: { message: 'Alert not found' } });
    res.json({ success: true, message: 'Alert deleted successfully' });
  } catch (error) {
    console.error('Delete alert error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while deleting alert' } });
  }
});

// @desc    Get alert statistics
// @route   GET /api/alerts/stats/overview
// @access  Private
router.get('/stats/overview', protect, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const stats = await Alert.aggregate([
      {
        $match: {
          userId: req.user._id,
          timestamp: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: null,
          totalAlerts: { $sum: 1 },
          activeAlerts: {
            $sum: { $cond: [{ $in: ['$status', ['active', 'acknowledged']] }, 1, 0] }
          },
          resolvedAlerts: {
            $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] }
          },
          criticalAlerts: {
            $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] }
          },
          highRiskAlerts: {
            $sum: { $cond: [{ $eq: ['$severity', 'high'] }, 1, 0] }
          },
          avgResponseTime: {
            $avg: {
              $subtract: ['$acknowledgedAt', '$timestamp']
            }
          }
        }
      }
    ]);

    const alertTypeBreakdown = await Alert.aggregate([
      {
        $match: {
          userId: req.user._id,
          timestamp: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: '$alertType',
          count: { $sum: 1 },
          avgSeverity: {
            $avg: {
              $switch: {
                branches: [
                  { case: { $eq: ['$severity', 'low'] }, then: 1 },
                  { case: { $eq: ['$severity', 'medium'] }, then: 2 },
                  { case: { $eq: ['$severity', 'high'] }, then: 3 },
                  { case: { $eq: ['$severity', 'critical'] }, then: 4 }
                ],
                default: 1
              }
            }
          }
        }
      },
      { $sort: { count: -1 } }
    ]);

    const severityBreakdown = await Alert.aggregate([
      {
        $match: {
          userId: req.user._id,
          timestamp: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: '$severity',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.json({
      success: true,
      data: {
        overview: stats[0] || {
          totalAlerts: 0,
          activeAlerts: 0,
          resolvedAlerts: 0,
          criticalAlerts: 0,
          highRiskAlerts: 0,
          avgResponseTime: 0
        },
        alertTypeBreakdown,
        severityBreakdown,
        timeRange: {
          start: startDate,
          end: new Date(),
          days: parseInt(days)
        }
      }
    });
  } catch (error) {
    console.error('Get alert stats error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while fetching alert statistics' } });
  }
});

// @desc    Get overdue alerts
// @route   GET /api/alerts/overdue
// @access  Private
router.get('/overdue', protect, async (req, res) => {
  try {
    const overdueAlerts = await Alert.getOverdueAlerts();
    res.json({ success: true, data: { overdueAlerts } });
  } catch (error) {
    console.error('Get overdue alerts error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while fetching overdue alerts' } });
  }
});

// @desc    Update notification status
// @route   PUT /api/alerts/:id/notifications/:contactId
// @access  Private
router.put(
  '/:id/notifications/:contactId',
  protect,
  [
    body('status').isIn(['sent', 'delivered', 'failed']).withMessage('Invalid notification status'),
    body('response').optional().isString().withMessage('Response must be a string')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, error: { message: 'Validation failed', details: errors.array() } });
      }

      const { id, contactId } = req.params;
      const { status, response } = req.body;

      const alert = await Alert.findOne({ _id: id, userId: req.user._id });
      if (!alert) {
        return res.status(404).json({ success: false, error: { message: 'Alert not found' } });
      }

      await alert.updateNotificationStatus(contactId, status, response);
      res.json({ success: true, data: { alert }, message: 'Notification status updated successfully' });
    } catch (error) {
      console.error('Update notification status error:', error);
      res.status(500).json({ success: false, error: { message: 'Server error while updating notification status' } });
    }
  }
);

// @desc    Trigger SOS alert
// @route   POST /api/alerts/sos
// @access  Private
router.post('/sos', protect, async (req, res) => {
  try {
    const { location = 'Unknown location', includeEmergencyCall = false } = req.body;

    const alertData = {
      userId: req.user._id,
      alertType: 'sos',
      severity: 'critical',
      title: 'SOS Alert Triggered',
      description: 'The user has manually triggered an SOS alert from the dashboard.',
      location
    };

    const alert = await Alert.create(alertData);

    // Try SOS to emergency number
    let sosResult = null;
    try {
      sosResult = await sosService.sendSOSAlert(req.user, location);
    } catch (sosError) {
      console.error('Failed to send SOS to emergency number:', sosError);
    }

    // Optional emergency call
    let emergencyCallResult = null;
    if (includeEmergencyCall) {
      try {
        emergencyCallResult = await sosService.initiateEmergencyCall(req.user, location);
      } catch (callError) {
        console.error('Failed to initiate emergency call:', callError);
      }
    }

    // Send to all active contacts
    const contacts = await Contact.find({ userId: req.user._id, isActive: true });

    const recipients = getAlertRecipientsFromEnv();
    for (const contact of contacts) {
      if (contact.notificationPreferences.email.enabled) {
        await alert.addNotification(contact._id, 'email');
        if (recipients.length) {
          try {
            const payload = buildAlertEmail(alert, req.user);
            const result = await sendEmail({ to: recipients, ...payload });
            await alert.updateNotificationStatus(contact._id, 'sent', `Email sent: ${result.messageId || 'ok'}`);
          } catch (err) {
            console.error('Email send failed (SOS):', err?.message);
            await alert.updateNotificationStatus(contact._id, 'failed', err?.message || 'Email failed');
          }
        } else {
          await alert.updateNotificationStatus(contact._id, 'failed', 'No ALERT_EMAIL_TO configured');
        }
      }

      if (contact.notificationPreferences.sms.enabled) {
        await alert.addNotification(contact._id, 'sms');
        try {
          await smsService.sendAlertSMS(contact.phone, alert);
          await alert.updateNotificationStatus(contact._id, 'sent', 'SMS sent');
        } catch (err) {
          await alert.updateNotificationStatus(contact._id, 'failed', err?.message || 'SMS failed');
        }
      }

      if (contact.notificationPreferences.push.enabled) {
        await alert.addNotification(contact._id, 'push');
        const push = buildSosPush(location);
        sendPush(push).catch((e) => console.error('Push send failed (SOS):', e?.message));
      }
    }

    res.status(201).json({
      success: true,
      data: { alert, sosResult, emergencyCallResult, contactResults: [] },
      message: 'SOS alert triggered successfully. Emergency services and contacts are being notified.'
    });
  } catch (error) {
    console.error('SOS alert error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while triggering SOS alert' } });
  }
});

// @desc    Trigger Emergency Call
// @route   POST /api/alerts/emergency-call
// @access  Private
router.post('/emergency-call', protect, async (req, res) => {
  try {
    const { location = 'Unknown location' } = req.body;

    const alertData = {
      userId: req.user._id,
      alertType: 'sos',
      severity: 'critical',
      title: 'Emergency Call Requested',
      description: 'The user has requested an emergency call to ambulance services.',
      location
    };

    const alert = await Alert.create(alertData);

    let emergencyCallResult = null;
    try {
      emergencyCallResult = await sosService.initiateEmergencyCall(req.user, location);
    } catch (callError) {
      console.error('Failed to initiate emergency call:', callError);
    }

    // Also send SOS to contacts (email recipients from env if enabled)
    const contacts = await Contact.find({ userId: req.user._id, isActive: true });
    const recipients = getAlertRecipientsFromEnv();

    for (const contact of contacts) {
      if (contact.notificationPreferences.email.enabled) {
        await alert.addNotification(contact._id, 'email');
        if (recipients.length) {
          try {
            const payload = buildAlertEmail(alert, req.user);
            const result = await sendEmail({ to: recipients, ...payload });
            await alert.updateNotificationStatus(contact._id, 'sent', `Email sent: ${result.messageId || 'ok'}`);
          } catch (err) {
            await alert.updateNotificationStatus(contact._id, 'failed', err?.message || 'Email failed');
          }
        } else {
          await alert.updateNotificationStatus(contact._id, 'failed', 'No ALERT_EMAIL_TO configured');
        }
      }
    }

    res.status(201).json({
      success: true,
      data: { alert, emergencyCallResult, contactResults: [] },
      message: 'Emergency call initiated successfully. Ambulance services and contacts are being notified.'
    });
  } catch (error) {
    console.error('Emergency call error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while initiating emergency call' } });
  }
});

// @desc    Get all alerts (Admin only)
// @route   GET /api/alerts/admin/all
// @access  Private, Admin only
router.get('/admin/all', protect, authorize('admin'), async (req, res) => {
  try {
    const { page = 1, limit = 50, status, severity, alertType } = req.query;

    const query = {};
    if (status) query.status = status;
    if (severity) query.severity = severity;
    if (alertType) query.alertType = alertType;

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { timestamp: -1 }
    };

    const alerts = await Alert.find(query)
      .sort(options.sort)
      .limit(options.limit)
      .skip((options.page - 1) * options.limit)
      .populate('userId', 'firstName lastName email')
      .populate('monitoringSessionId', 'sessionId deviceInfo');

    const total = await Alert.countDocuments(query);

    res.json({
      success: true,
      data: {
        alerts,
        pagination: {
          page: options.page,
          limit: options.limit,
          total,
          pages: Math.ceil(total / options.limit)
        }
      }
    });
  } catch (error) {
    console.error('Get all alerts error:', error);
    res.status(500).json({ success: false, error: { message: 'Server error while fetching all alerts' } });
  }
});

module.exports = router;
