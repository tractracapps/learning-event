const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
require('dotenv').config();

const Attendee = require('./models/Attendee');
const Event = require('./models/Event');

const PORT = process.env.PORT || 3000;

const JWT_SECRET =
  process.env.JWT_SECRET || 'change-this-secret-before-deploying';

const STAFF_PASSWORD =
  process.env.STAFF_PASSWORD || 'Tractrac0';

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || '';

const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY || '';

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));


// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/health', (req, res) => {
  const dbReady = mongoose.connection.readyState === 1;

  res.status(dbReady ? 200 : 503).json({
    status: dbReady ? 'ok' : 'degraded',
    db: dbReady ? 'connected' : 'disconnected',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});


// =====================================================
// LEGACY EVENT META MODEL
// Kept for compatibility with the existing system
// =====================================================

const eventMetaSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      default: 'Year 2 Learning Event'
    },

    date: {
      type: String,
      default: ''
    },

    capacity: {
      type: Number,
      default: 170
    }
  },
  {
    timestamps: true
  }
);

const EventMeta =
  mongoose.models.EventMeta ||
  mongoose.model('EventMeta', eventMetaSchema);


// =====================================================
// HELPERS
// =====================================================

function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// =====================================================
// EVENT META HELPERS
// =====================================================

async function getMeta() {
  let meta = await EventMeta.findOne().lean();

  if (!meta) {
    const created = await EventMeta.create({
      name: 'Year 2 Learning Event',
      date: '',
      capacity: 170
    });

    return created.toObject();
  }

  return meta;
}

async function updateMeta(values) {
  return EventMeta.findOneAndUpdate(
    {},
    {
      $set: values
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true
    }
  ).lean();
}


// =====================================================
// MULTI-EVENT MIGRATION
// =====================================================

async function migrateToMultiEvent() {
  console.log('Checking multi-event migration...');

  const oldMeta = await EventMeta.findOne().lean();

  let learningEvent = await Event.findOne({
    name: oldMeta?.name || 'Year 2 Learning Event'
  });

  if (!learningEvent) {
    learningEvent = await Event.create({
      name: oldMeta?.name || 'Year 2 Learning Event',
      date: oldMeta?.date || '',
      capacity: oldMeta?.capacity || 170,
      location: '',
      status: 'active'
    });

    console.log(
      `Created Learning Event: ${learningEvent._id}`
    );
  }

  const result = await Attendee.updateMany(
    {
      $or: [
        {
          eventId: {
            $exists: false
          }
        },
        {
          eventId: null
        }
      ]
    },
    {
      $set: {
        eventId: learningEvent._id
      }
    }
  );

  console.log(
    `Migration complete. ${result.modifiedCount} attendee(s) assigned to Learning Event.`
  );

  return learningEvent;
}


// =====================================================
// STATS
// =====================================================

async function computeStats(eventId) {
  const filter = {
    eventId
  };

  const [
    totalAttendees,
    checkedInCount
  ] = await Promise.all([
    Attendee.countDocuments(filter),

    Attendee.countDocuments({
      ...filter,
      checkedIn: true
    })
  ]);

  return {
    totalAttendees,
    checkedInCount,
    notCheckedInCount:
      totalAttendees - checkedInCount
  };
}


// =====================================================
// AUTHENTICATION
// =====================================================

function requireAuth(req, res, next) {
  const header =
    req.headers.authorization || '';

  const token =
    header.startsWith('Bearer ')
      ? header.slice(7)
      : null;

  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized access'
    });
  }

  try {
    const decoded =
      jwt.verify(token, JWT_SECRET);

    req.user = decoded;

    next();

  } catch (error) {
    return res.status(401).json({
      error: 'Unauthorized access'
    });
  }
}


// =====================================================
// ADMIN-ONLY AUTHORIZATION
// =====================================================

function requireAdmin(req, res, next) {
  if (
    !req.user ||
    req.user.role !== 'admin'
  ) {
    return res.status(403).json({
      error: 'Admin access required'
    });
  }

  next();
}


// =====================================================
// STAFF OR ADMIN AUTHORIZATION
// =====================================================

function requireStaff(req, res, next) {
  if (
    !req.user ||
    !['staff', 'admin'].includes(req.user.role)
  ) {
    return res.status(403).json({
      error: 'Staff access required'
    });
  }

  next();
}


// =====================================================
// LOGIN
// =====================================================

app.post('/api/staff/login', (req, res) => {
  const {
    password,
    role
  } = req.body || {};

  const requestedRole =
    role === 'admin'
      ? 'admin'
      : 'staff';

  const expectedPassword =
    requestedRole === 'admin'
      ? ADMIN_PASSWORD
      : STAFF_PASSWORD;

  // Admin password must be configured
  if (
    requestedRole === 'admin' &&
    !ADMIN_PASSWORD
  ) {
    return res.status(500).json({
      error:
        'Admin password is not configured on the server.'
    });
  }

  if (password !== expectedPassword) {
    return res.status(401).json({
      error: 'Incorrect password'
    });
  }

  const token = jwt.sign(
    {
      role: requestedRole
    },
    JWT_SECRET,
    {
      expiresIn: '12h'
    }
  );

  res.json({
    token,
    role: requestedRole
  });
});


// =====================================================
// EVENTS
// =====================================================

// -----------------------------------------------------
// GET ALL EVENTS
// Admin + Registration Staff
// -----------------------------------------------------

app.get(
  '/api/staff/events',
  requireAuth,
  requireStaff,
  async (req, res) => {
    try {
      const events = await Event.find({})
        .sort({
          createdAt: -1
        })
        .lean();

      res.json(events);

    } catch (error) {
      console.error(
        'Load events error:',
        error
      );

      res.status(500).json({
        error: 'Failed to load events.'
      });
    }
  }
);


// -----------------------------------------------------
// GET ONE EVENT
// Admin + Registration Staff
// -----------------------------------------------------

app.get(
  '/api/staff/events/:id',
  requireAuth,
  requireStaff,
  async (req, res) => {
    try {
      const event =
        await Event.findById(
          req.params.id
        ).lean();

      if (!event) {
        return res.status(404).json({
          error: 'Event not found.'
        });
      }

      res.json(event);

    } catch (error) {
      console.error(
        'Load event error:',
        error
      );

      if (
        error instanceof mongoose.Error.CastError
      ) {
        return res.status(400).json({
          error: 'Invalid event ID.'
        });
      }

      res.status(500).json({
        error: 'Failed to load event.'
      });
    }
  }
);


// -----------------------------------------------------
// CREATE EVENT
// ADMIN ONLY
// -----------------------------------------------------

app.post(
  '/api/staff/events',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        name,
        date,
        location,
        capacity,
        status
      } = req.body || {};

      if (
        !name ||
        !String(name).trim()
      ) {
        return res.status(400).json({
          error: 'Event name is required.'
        });
      }

      const parsedCapacity =
        parseInt(capacity, 10);

      if (
        Number.isNaN(parsedCapacity) ||
        parsedCapacity <= 0
      ) {
        return res.status(400).json({
          error:
            'Event capacity must be greater than 0.'
        });
      }

      const allowedStatuses = [
        'draft',
        'active',
        'closed',
        'archived'
      ];

      const eventStatus =
        status || 'draft';

      if (
        !allowedStatuses.includes(
          eventStatus
        )
      ) {
        return res.status(400).json({
          error: 'Invalid event status.'
        });
      }

      const event =
        await Event.create({
          name:
            String(name).trim(),

          date:
            date || '',

          location:
            location || '',

          capacity:
            parsedCapacity,

          status:
            eventStatus
        });

      res.status(201).json(event);

    } catch (error) {
      console.error(
        'Create event error:',
        error
      );

      res.status(500).json({
        error: 'Failed to create event.'
      });
    }
  }
);


// -----------------------------------------------------
// UPDATE EVENT
// ADMIN ONLY
// -----------------------------------------------------

app.patch(
  '/api/staff/events/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        name,
        date,
        location,
        capacity,
        status
      } = req.body || {};

      const updates = {};

      if (name !== undefined) {
        if (!String(name).trim()) {
          return res.status(400).json({
            error:
              'Event name cannot be empty.'
          });
        }

        updates.name =
          String(name).trim();
      }

      if (date !== undefined) {
        updates.date = date;
      }

      if (location !== undefined) {
        updates.location =
          location;
      }

      if (capacity !== undefined) {
        const parsedCapacity =
          parseInt(capacity, 10);

        if (
          Number.isNaN(
            parsedCapacity
          ) ||
          parsedCapacity <= 0
        ) {
          return res.status(400).json({
            error:
              'Event capacity must be greater than 0.'
          });
        }

        updates.capacity =
          parsedCapacity;
      }

      if (status !== undefined) {
        const allowedStatuses = [
          'draft',
          'active',
          'closed',
          'archived'
        ];

        if (
          !allowedStatuses.includes(
            status
          )
        ) {
          return res.status(400).json({
            error:
              'Invalid event status.'
          });
        }

        updates.status =
          status;
      }

      const event =
        await Event.findByIdAndUpdate(
          req.params.id,
          {
            $set: updates
          },
          {
            new: true,
            runValidators: true
          }
        ).lean();

      if (!event) {
        return res.status(404).json({
          error:
            'Event not found.'
        });
      }

      res.json(event);

    } catch (error) {
      console.error(
        'Update event error:',
        error
      );

      if (
        error instanceof mongoose.Error.CastError
      ) {
        return res.status(400).json({
          error:
            'Invalid event ID.'
        });
      }

      res.status(500).json({
        error:
          'Failed to update event.'
      });
    }
  }
);


// -----------------------------------------------------
// DELETE EVENT
// ADMIN ONLY
// -----------------------------------------------------

app.delete(
  '/api/staff/events/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const event =
        await Event.findById(
          req.params.id
        );

      if (!event) {
        return res.status(404).json({
          error:
            'Event not found.'
        });
      }

      // Delete only attendees
      // belonging to this event
      const attendeeResult =
        await Attendee.deleteMany({
          eventId: event._id
        });

      await Event.findByIdAndDelete(
        event._id
      );

      res.json({
        ok: true,

        message:
          'Event deleted successfully.',

        deletedAttendees:
          attendeeResult.deletedCount
      });

    } catch (error) {
      console.error(
        'Delete event error:',
        error
      );

      if (
        error instanceof mongoose.Error.CastError
      ) {
        return res.status(400).json({
          error:
            'Invalid event ID.'
        });
      }

      res.status(500).json({
        error:
          'Failed to delete event.'
      });
    }
  }
);


// =====================================================
// LEGACY EVENT META
// =====================================================

// GET META
// Admin + Staff

app.get(
  '/api/staff/meta',
  requireAuth,
  requireStaff,
  async (req, res) => {
    try {
      res.json(
        await getMeta()
      );

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Failed to load event details.'
      });
    }
  }
);


// UPDATE META
// ADMIN ONLY

app.put(
  '/api/staff/meta',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        name,
        date,
        capacity
      } = req.body || {};

      const updates = {};

      if (name !== undefined) {
        updates.name = name;
      }

      if (date !== undefined) {
        updates.date = date;
      }

      if (capacity !== undefined) {
        const cap =
          parseInt(
            capacity,
            10
          );

        updates.capacity =
          Number.isNaN(cap) ||
          cap <= 0
            ? 170
            : cap;
      }

      await updateMeta(
        updates
      );

      res.json(
        await getMeta()
      );

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Failed to update event details.'
      });
    }
  }
);


// =====================================================
// PAYSTACK BANK ACCOUNT VERIFICATION
// Admin + Staff
// =====================================================

app.get(
  '/api/staff/banks/resolve',
  requireAuth,
  requireStaff,
  async (req, res) => {
    try {
      const {
        accountNumber,
        bankCode
      } = req.query;

      if (
        !accountNumber ||
        !bankCode
      ) {
        return res.status(400).json({
          error:
            'Account number and bank code are required'
        });
      }

      const cleanAccountNumber =
        String(
          accountNumber
        ).replace(
          /\D/g,
          ''
        );

      if (
        cleanAccountNumber.length !==
        10
      ) {
        return res.status(400).json({
          error:
            'Account number must be 10 digits'
        });
      }

      if (!PAYSTACK_SECRET_KEY) {
        console.error(
          'PAYSTACK_SECRET_KEY is missing from .env'
        );

        return res.status(500).json({
          error:
            'Paystack is not configured on the server'
        });
      }

      const paystackUrl =
        `https://api.paystack.co/bank/resolve` +
        `?account_number=${encodeURIComponent(
          cleanAccountNumber
        )}` +
        `&bank_code=${encodeURIComponent(
          bankCode
        )}`;

      const response =
        await fetch(
          paystackUrl,
          {
            method: 'GET',

            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET_KEY}`,

              Accept:
                'application/json'
            }
          }
        );

      const data =
        await response.json();

      if (
        !response.ok ||
        !data.status
      ) {
        const safeStatus =
          response.status === 401 ||
          response.status === 403
            ? 502
            : (
                response.status ||
                400
              );

        return res.status(
          safeStatus
        ).json({
          error:
            data.message ||
            'Could not verify this account number'
        });
      }

      return res.json({
        accountNumber:
          data.data.account_number,

        accountName:
          data.data.account_name
      });

    } catch (error) {
      console.error(
        'Paystack bank verification error:',
        error
      );

      return res.status(500).json({
        error:
          'Unable to connect to Paystack'
      });
    }
  }
);


// =====================================================
// GET ATTENDEES
// Admin + Registration Staff
// =====================================================

app.get(
  '/api/staff/attendees',
  requireAuth,
  requireStaff,
  async (req, res) => {
    try {
      const {
        eventId,
        search = '',
        checkedIn
      } = req.query;

      if (!eventId) {
        return res.status(400).json({
          error:
            'eventId is required'
        });
      }

      const event =
        await Event.findById(
          eventId
        ).lean();

      if (!event) {
        return res.status(404).json({
          error:
            'Event not found'
        });
      }

      const filter = {
        eventId
      };

      if (
        checkedIn === 'true'
      ) {
        filter.checkedIn = true;
      }

      if (
        checkedIn === 'false'
      ) {
        filter.checkedIn = false;
      }

      const q =
        String(search).trim();

      if (q) {
        const regex =
          new RegExp(
            escapeRegex(q),
            'i'
          );

        filter.$or = [
          {
            name: regex
          },
          {
            phone: regex
          },
          {
            email: regex
          },
          {
            organization: regex
          }
        ];
      }

      const [
        rows,
        stats
      ] = await Promise.all([
        Attendee
          .find(filter)
          .sort({
            name: 1
          })
          .lean(),

        computeStats(
          eventId
        )
      ]);

      const items =
        rows.map(row => {
          const {
            _id,
            signatureData,
            ...rest
          } = row;

          return {
            ...rest,

            id:
              _id.toString(),

            checkedIn:
              !!row.checkedIn,

            hasSignature:
              !!signatureData
          };
        });

      res.json({
        items,

        total:
          rows.length,

        stats
      });

    } catch (error) {
      console.error(
        'Load attendees error:',
        error
      );

      if (
        error instanceof mongoose.Error.CastError
      ) {
        return res.status(400).json({
          error:
            'Invalid event ID.'
        });
      }

      res.status(500).json({
        error:
          'Failed to load attendees.'
      });
    }
  }
);


// =====================================================
// ADD ATTENDEE
// Admin + Registration Staff
// =====================================================

app.post(
  '/api/staff/attendees',
  requireAuth,
  requireStaff,
  async (req, res) => {
    try {
      const {
        eventId,
        name,
        phone,
        email,
        organization,
        gender,
        disabilityType,
        ageRange,
        state,
        lga,
        designation,
        address,
        bankName,
        bankCode,
        accountNumber,
        accountName
      } = req.body;

      if (!eventId) {
        return res.status(400).json({
          error:
            'eventId is required'
        });
      }

      // Manual registration still requires
      // both name and phone.
      if (
        !name ||
        !phone
      ) {
        return res.status(400).json({
          error:
            'Name and phone are required'
        });
      }

      const event =
        await Event.findById(
          eventId
        ).lean();

      if (!event) {
        return res.status(404).json({
          error:
            'Event not found'
        });
      }

      if (
        event.status === 'closed' ||
        event.status === 'archived'
      ) {
        return res.status(400).json({
          error:
            'Registration is closed for this event'
        });
      }

      const total =
        await Attendee.countDocuments({
          eventId
        });

      if (
        total >= event.capacity
      ) {
        return res.status(400).json({
          error:
            'Event capacity has been reached'
        });
      }

      const normalizedPhone =
        normalizePhone(
          phone
        );

      const attendees =
        await Attendee.find(
          {
            eventId
          },
          {
            phone: 1
          }
        ).lean();

      const duplicate =
        attendees.some(
          attendee =>
            normalizePhone(
              attendee.phone
            ) === normalizedPhone
        );

      if (duplicate) {
        return res.status(409).json({
          error:
            'An attendee with this phone number already exists for this event'
        });
      }

      const attendee =
        await Attendee.create({
          eventId,

          name,
          phone,

          email:
            email || '',

          organization:
            organization || '',

          gender:
            gender || '',

          disabilityType:
            disabilityType || '',

          ageRange:
            ageRange || '',

          state:
            state || '',

          lga:
            lga || '',

          designation:
            designation || '',

          address:
            address || '',

          bankName:
            bankName || '',

          bankCode:
            bankCode || '',

          accountNumber:
            accountNumber || '',

          accountName:
            accountName || '',

          signatureData:
            null,

          checkedIn:
            false,

          checkedInAt:
            null,

          checkedOutAt:
            null,

          addedAt:
            new Date()
        });

      res.status(201).json({
        id:
          attendee._id,

        ...attendee.toObject()
      });

    } catch (error) {
      console.error(
        'Add attendee error:',
        error
      );

      if (
        error instanceof mongoose.Error.CastError
      ) {
        return res.status(400).json({
          error:
            'Invalid event ID'
        });
      }

      res.status(500).json({
        error:
          'Failed to add attendee'
      });
    }
  }
);


// =====================================================
// UPDATE ATTENDEE / CHECK-IN / CHECK-OUT
// Admin + Registration Staff
// =====================================================

app.patch(
  '/api/staff/attendees/:id',
  requireAuth,
  requireStaff,
  async (req, res) => {
    try {
      const {
        eventId
      } = req.body || {};

      if (!eventId) {
        return res.status(400).json({
          error:
            'eventId is required'
        });
      }

      const attendee =
        await Attendee.findOne({
          _id:
            req.params.id,

          eventId
        });

      if (!attendee) {
        return res.status(404).json({
          error:
            'Attendee not found for this event'
        });
      }

      const {
        name,
        phone,
        email,
        organization,
        gender,
        disabilityType,
        ageRange,
        state,
        lga,
        designation,
        address,
        bankName,
        bankCode,
        accountNumber,
        accountName,
        checkedIn,
        signatureData
      } = req.body;

      if (name !== undefined)
        attendee.name = name;

      if (phone !== undefined)
        attendee.phone = phone;

      if (email !== undefined)
        attendee.email = email;

      if (organization !== undefined)
        attendee.organization =
          organization;

      if (gender !== undefined)
        attendee.gender = gender;

      if (
        disabilityType !== undefined
      )
        attendee.disabilityType =
          disabilityType;

      if (ageRange !== undefined)
        attendee.ageRange =
          ageRange;

      if (state !== undefined)
        attendee.state =
          state;

      if (lga !== undefined)
        attendee.lga =
          lga;

      if (designation !== undefined)
        attendee.designation =
          designation;

      if (address !== undefined)
        attendee.address =
          address;

      if (bankName !== undefined)
        attendee.bankName =
          bankName;

      if (bankCode !== undefined)
        attendee.bankCode =
          bankCode;

      if (accountNumber !== undefined)
        attendee.accountNumber =
          accountNumber;

      if (accountName !== undefined)
        attendee.accountName =
          accountName;

      const isCheckingInNow =
        checkedIn === true &&
        attendee.checkedIn !== true;

      if (
        isCheckingInNow &&
        !signatureData
      ) {
        return res.status(400).json({
          error:
            'Signature is required when checking in'
        });
      }

      if (
        signatureData !== undefined
      ) {
        attendee.signatureData =
          signatureData;
      }

      if (
        checkedIn !== undefined
      ) {

        if (
          checkedIn === true &&
          attendee.checkedIn !== true
        ) {
          attendee.checkedIn = true;

          attendee.checkedInAt =
            new Date();

          attendee.checkedOutAt =
            null;
        }

        if (
          checkedIn === false &&
          attendee.checkedIn === true
        ) {
          attendee.checkedIn =
            false;

          attendee.checkedOutAt =
            new Date();
        }
      }

      await attendee.save();

      res.json({
        id:
          attendee._id,

        ...attendee.toObject()
      });

    } catch (error) {
      console.error(
        'Update attendee error:',
        error
      );

      if (
        error instanceof mongoose.Error.CastError
      ) {
        return res.status(400).json({
          error:
            'Invalid attendee or event ID'
        });
      }

      res.status(500).json({
        error:
          'Failed to update attendee'
      });
    }
  }
);


// =====================================================
// DELETE ATTENDEE
// ADMIN ONLY
// =====================================================

app.delete(
  '/api/staff/attendees/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        eventId
      } = req.body || {};

      if (!eventId) {
        return res.status(400).json({
          error:
            'eventId is required'
        });
      }

      const deleted =
        await Attendee.findOneAndDelete({
          _id:
            req.params.id,

          eventId
        });

      if (!deleted) {
        return res.status(404).json({
          error:
            'Attendee not found for this event.'
        });
      }

      res.json({
        ok: true
      });

    } catch (error) {
      console.error(
        'Delete attendee error:',
        error
      );

      if (
        error instanceof mongoose.Error.CastError
      ) {
        return res.status(400).json({
          error:
            'Invalid attendee or event ID.'
        });
      }

      res.status(500).json({
        error:
          'Failed to delete attendee.'
      });
    }
  }
);


// =====================================================
// BULK DELETE ATTENDEES
// ADMIN ONLY
// =====================================================

app.post(
  '/api/staff/attendees/bulk-delete',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        eventId,
        ids
      } = req.body || {};

      if (!eventId) {
        return res.status(400).json({
          error:
            'eventId is required'
        });
      }

      if (
        !Array.isArray(ids) ||
        ids.length === 0
      ) {
        return res.json({
          deleted: 0
        });
      }

      const result =
        await Attendee.deleteMany({
          _id: {
            $in: ids
          },

          eventId
        });

      res.json({
        deleted:
          result.deletedCount
      });

    } catch (error) {
      console.error(
        'Bulk delete error:',
        error
      );

      res.status(400).json({
        error:
          'Failed to delete selected attendees.'
      });
    }
  }
);


// =====================================================
// BULK IMPORT
// ADMIN ONLY
// =====================================================

app.post(
  '/api/staff/attendees/import',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        eventId,
        rows
      } = req.body || {};

      if (!eventId) {
        return res.status(400).json({
          error:
            'eventId is required'
        });
      }

      if (!Array.isArray(rows)) {
        return res.status(400).json({
          error:
            'rows must be an array'
        });
      }

      const event =
        await Event.findById(
          eventId
        ).lean();

      if (!event) {
        return res.status(404).json({
          error:
            'Event not found'
        });
      }

      if (
        event.status === 'closed' ||
        event.status === 'archived'
      ) {
        return res.status(400).json({
          error:
            'Registration is closed for this event'
        });
      }

      // Get existing attendees for
      // THIS event only.
      const existingAttendees =
        await Attendee.find(
          {
            eventId
          },
          {
            phone: 1
          }
        ).lean();

      const existingPhones =
        new Set(
          existingAttendees.map(
            attendee =>
              normalizePhone(
                attendee.phone
              )
          )
        );

      const importPhones =
        new Set();

      const documents = [];

      let duplicates = 0;
      let invalid = 0;

      for (
        const row of rows
      ) {

        // NAME IS THE ONLY REQUIRED
        // FIELD FOR BULK IMPORT.
        const name =
          String(
            row.name || ''
          ).trim();

        const phone =
          String(
            row.phone || ''
          ).trim();

        if (!name) {
          invalid++;
          continue;
        }

        const normalizedPhone =
          normalizePhone(
            phone
          );

        // Only check for duplicate
        // phones when a phone exists.
        //
        // This means blank phones are
        // NOT treated as duplicates.
        if (
          normalizedPhone &&
          (
            existingPhones.has(
              normalizedPhone
            ) ||
            importPhones.has(
              normalizedPhone
            )
          )
        ) {
          duplicates++;
          continue;
        }

        if (normalizedPhone) {
          importPhones.add(
            normalizedPhone
          );
        }

        documents.push({
          eventId,

          name,

          phone,

          email:
            row.email || '',

          organization:
            row.organization || '',

          gender:
            row.gender || '',

          disabilityType:
            row.disabilityType || '',

          ageRange:
            row.ageRange || '',

          state:
            row.state || '',

          lga:
            row.lga || '',

          designation:
            row.designation || '',

          address:
            row.address || '',

          bankName:
            row.bankName || '',

          bankCode:
            row.bankCode || '',

          accountNumber:
            row.accountNumber || '',

          accountName:
            row.accountName || '',

          signatureData:
            null,

          checkedIn:
            false,

          checkedInAt:
            null,

          checkedOutAt:
            null,

          addedAt:
            new Date()
        });
      }

      const currentTotal =
        await Attendee.countDocuments({
          eventId
        });

      const availableSlots =
        Math.max(
          0,
          event.capacity -
            currentTotal
        );

      const allowedDocuments =
        documents.slice(
          0,
          availableSlots
        );

      const overCapacity =
        Math.max(
          0,
          documents.length -
            allowedDocuments.length
        );

      let added = 0;

      if (
        allowedDocuments.length > 0
      ) {
        const inserted =
          await Attendee.insertMany(
            allowedDocuments
          );

        added =
          inserted.length;
      }

      res.json({
        added,
        duplicates,
        overCapacity,
        invalid
      });

    } catch (error) {
      console.error(
        'Import attendees error:',
        error
      );

      if (
        error instanceof mongoose.Error.CastError
      ) {
        return res.status(400).json({
          error:
            'Invalid event ID'
        });
      }

      res.status(500).json({
        error:
          'Failed to import attendees'
      });
    }
  }
);


// =====================================================
// STATIC FRONTEND
// =====================================================

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);

app.get(
  '*',
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );
  }
);


// =====================================================
// CONNECT TO MONGODB
// =====================================================

mongoose
  .connect(
    process.env.MONGODB_URI
  )

  .then(async () => {

    console.log(
      'Connected to MongoDB'
    );

    try {

      await migrateToMultiEvent();

      app.listen(
        PORT,
        () => {
          console.log(
            `Registration server running on http://localhost:${PORT}`
          );
        }
      );

    } catch (error) {

      console.error(
        'Multi-event migration failed:',
        error
      );

      process.exit(1);
    }

  })

  .catch(error => {

    console.error(
      'MongoDB connection failed:',
      error
    );

    process.exit(1);

  });