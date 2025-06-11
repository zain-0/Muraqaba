import Bus from '../models/Bus.js';
import User from '../models/User.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';

// Controller to get all buses
export const getAllBuses = asyncHandler(async (req, res) => {
    const buses = await Bus.find().populate('vendor', 'name email');
    
    res.status(200).json({
        success: true,
        count: buses.length,
        data: buses
    });
});

// Controller to get a single bus by ID
export const getBusById = asyncHandler(async (req, res) => {
    const bus = await Bus.findById(req.params.id).populate('vendor', 'name email');
    
    if (!bus) {
        throw new AppError('Bus not found', 404);
    }
    
    res.status(200).json({
        success: true,
        data: bus
    });
});

// Controller to create a new bus
export const createBus = asyncHandler(async (req, res) => {
    const {
        chassisNumber,
        fleetNumber,
        registrationNumber,
        make,
        model,
        year,
        engine,
        ac,
        tyre,
        transmission,
        brakePad,
        vendorId,
    } = req.body;

    // Validate vendor exists
    const vendorUser = await User.findById(vendorId);
    if (!vendorUser) {
        throw new AppError('Vendor not found', 404);
    }

    // Validate vendor role
    if (vendorUser.role !== 'vendor') {
        throw new AppError('Selected user is not a vendor', 400);
    }

    // Validate nested parts
    const parts = { engine, ac, tyre, transmission, brakePad };
    for (const [key, value] of Object.entries(parts)) {
        if (!value || typeof value.serviceKm !== 'number' || typeof value.currentKm !== 'number') {
            throw new AppError(`Missing or invalid serviceKm/currentKm in ${key}`, 400);
        }
        if (value.currentKm < 0 || value.serviceKm < 0) {
            throw new AppError(`${key} kilometers cannot be negative`, 400);
        }
    }

    const newBus = new Bus({
        chassisNumber,
        fleetNumber,
        registrationNumber,
        make,
        model,
        year,
        engine,
        ac,
        tyre,
        transmission,
        brakePad,
        vendor: vendorUser._id,
    });

    await newBus.save();

    // Populate vendor information for response
    await newBus.populate('vendor', 'name email');

    res.status(201).json({
        success: true,
        message: 'Bus created successfully',
        data: newBus,
    });
});
